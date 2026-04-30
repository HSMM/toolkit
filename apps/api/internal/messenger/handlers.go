// Package messenger contains Toolkit messenger APIs.
package messenger

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/sysset"
	"github.com/HSMM/toolkit/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const providerTelegram = "telegram"
const maxTelegramUploadBytes = 50 << 20

type Config struct {
	TelegramAPIID                int
	TelegramAPIHash              string
	TelegramSessionEncryptionKey string
	TelegramSyncEnabled          bool
	TelegramRetentionDays        int
	TelegramWorkerURL            string
}

type Handlers struct {
	db            *pgxpool.Pool
	cfg           Config
	hub           *ws.Hub
	updateSecrets sync.Map // account_id -> callback secret
}

func NewHandlers(db *pgxpool.Pool, cfg Config, hub ...*ws.Hub) *Handlers {
	if cfg.TelegramRetentionDays <= 0 {
		cfg.TelegramRetentionDays = 180
	}
	h := &Handlers{db: db, cfg: cfg}
	if len(hub) > 0 {
		h.hub = hub[0]
	}
	return h
}

func (h *Handlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/telegram/status", h.telegramStatus)
	r.Post("/telegram/auth/qr/start", h.telegramQRStart)
	r.Get("/telegram/auth/qr/{loginID}", h.telegramQRPoll)
	r.Delete("/telegram/session", h.telegramDisconnect)
	r.Post("/telegram/sync", h.telegramSync)
	r.Get("/telegram/chats", h.telegramChats)
	r.Post("/telegram/chats/{chatID}/sync", h.telegramChatSync)
	r.Get("/telegram/chats/{chatID}/messages", h.telegramMessages)
	r.Post("/telegram/chats/{chatID}/messages", h.telegramSendMessage)
	r.Get("/telegram/attachments/{attachmentID}/download", h.telegramDownloadAttachment)
	return r
}

func (h *Handlers) InternalRoutes() http.Handler {
	r := chi.NewRouter()
	r.Post("/telegram/updates", h.telegramWorkerUpdate)
	return r
}

type telegramStatusResponse struct {
	Configured  bool             `json:"configured"`
	Connected   bool             `json:"connected"`
	SyncEnabled bool             `json:"sync_enabled"`
	Policy      telegramPolicy   `json:"policy"`
	Account     *telegramAccount `json:"account,omitempty"`
}

type telegramPolicy struct {
	ReuseAllowed      bool `json:"reuse_allowed"`
	RetentionDays     int  `json:"retention_days"`
	SyncPrivateChats  bool `json:"sync_private_chats"`
	SyncGroups        bool `json:"sync_groups"`
	SyncChannels      bool `json:"sync_channels"`
	InitialCacheLimit int  `json:"initial_cache_limit"`
}

type telegramAccount struct {
	ID             uuid.UUID  `json:"id,omitempty"`
	ProviderUserID string     `json:"provider_user_id,omitempty"`
	DisplayName    string     `json:"display_name"`
	Username       string     `json:"username"`
	PhoneMasked    string     `json:"phone_masked"`
	Status         string     `json:"status"`
	ErrorMessage   string     `json:"error_message,omitempty"`
	ConnectedAt    *time.Time `json:"connected_at,omitempty"`
	LastSyncAt     *time.Time `json:"last_sync_at,omitempty"`
}

type chatItem struct {
	ID                 uuid.UUID  `json:"id"`
	ProviderChatID     string     `json:"provider_chat_id"`
	Type               string     `json:"type"`
	Title              string     `json:"title"`
	UnreadCount        int        `json:"unread_count"`
	LastMessagePreview string     `json:"last_message_preview"`
	LastMessageAt      *time.Time `json:"last_message_at,omitempty"`
	Muted              bool       `json:"muted"`
	Pinned             bool       `json:"pinned"`
}

type telegramSyncResponse struct {
	Items    []chatItem `json:"items"`
	SyncedAt time.Time  `json:"synced_at"`
}

type workerSyncChat struct {
	ProviderChatID     string     `json:"provider_chat_id"`
	Type               string     `json:"type"`
	Title              string     `json:"title"`
	UnreadCount        int        `json:"unread_count"`
	LastMessagePreview string     `json:"last_message_preview"`
	LastMessageAt      *time.Time `json:"last_message_at,omitempty"`
	Pinned             bool       `json:"pinned"`
	Muted              bool       `json:"muted"`
}

type workerSyncResponse struct {
	Items []workerSyncChat `json:"items"`
}

type workerMessage struct {
	ProviderMessageID string             `json:"provider_message_id"`
	Direction         string             `json:"direction"`
	SenderProviderID  string             `json:"sender_provider_id"`
	SenderName        string             `json:"sender_name"`
	Text              string             `json:"text"`
	Status            string             `json:"status"`
	SentAt            time.Time          `json:"sent_at"`
	Attachments       []workerAttachment `json:"attachments"`
	Raw               json.RawMessage    `json:"raw,omitempty"`
}

type workerMessagesResponse struct {
	Items []workerMessage `json:"items"`
}

type workerAttachment struct {
	ProviderFileID string `json:"provider_file_id"`
	Kind           string `json:"kind"`
	FileName       string `json:"file_name"`
	MimeType       string `json:"mime_type"`
	SizeBytes      *int64 `json:"size_bytes,omitempty"`
	Width          *int   `json:"width,omitempty"`
	Height         *int   `json:"height,omitempty"`
	DurationSec    *int   `json:"duration_sec,omitempty"`
}

type workerUploadFile struct {
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`
}

type workerSendResponse struct {
	Items []workerMessage `json:"items"`
}

type workerMediaDownloadResponse struct {
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`
}

type workerUpdateRequest struct {
	AccountID      uuid.UUID     `json:"account_id"`
	ProviderChatID string        `json:"provider_chat_id"`
	Message        workerMessage `json:"message"`
}

type sendMessageRequest struct {
	Text  string             `json:"text"`
	Files []workerUploadFile `json:"files,omitempty"`
}

type messageItem struct {
	ID          uuid.UUID        `json:"id"`
	Direction   string           `json:"direction"`
	SenderName  string           `json:"sender_name"`
	Text        string           `json:"text"`
	Status      string           `json:"status"`
	SentAt      time.Time        `json:"sent_at"`
	Attachments []attachmentItem `json:"attachments"`
}

type attachmentItem struct {
	ID          uuid.UUID `json:"id"`
	Kind        string    `json:"kind"`
	FileName    string    `json:"file_name"`
	MimeType    string    `json:"mime_type"`
	SizeBytes   *int64    `json:"size_bytes,omitempty"`
	Width       *int      `json:"width,omitempty"`
	Height      *int      `json:"height,omitempty"`
	DurationSec *int      `json:"duration_sec,omitempty"`
	DownloadURL string    `json:"download_url"`
}

type telegramQRLogin struct {
	LoginID   string           `json:"login_id"`
	Status    string           `json:"status"`
	QRPayload string           `json:"qr_payload,omitempty"`
	QRImage   string           `json:"qr_image,omitempty"`
	ExpiresAt time.Time        `json:"expires_at"`
	Error     string           `json:"error,omitempty"`
	Session   string           `json:"session,omitempty"`
	Account   *telegramAccount `json:"account,omitempty"`
}

func (l telegramQRLogin) public() map[string]any {
	out := map[string]any{
		"login_id":   l.LoginID,
		"status":     l.Status,
		"qr_payload": l.QRPayload,
		"qr_image":   l.QRImage,
		"expires_at": l.ExpiresAt,
	}
	if l.Error != "" {
		out["error"] = l.Error
	}
	if l.Account != nil {
		out["account"] = l.Account
	}
	return out
}

func (h *Handlers) telegramStatus(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_status_failed", err.Error())
		return
	}
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_status_failed", err.Error())
		return
	}
	if account != nil && account.Status == "connected" {
		if session, err := h.loadTelegramSession(r.Context(), cfg, account.ID); err == nil {
			h.startTelegramUpdates(r.Context(), cfg, subj.UserID, account.ID, session)
		}
	}
	writeJSON(w, http.StatusOK, telegramStatusResponse{
		Configured:  telegramConfigured(cfg),
		Connected:   account != nil && account.Status == "connected",
		SyncEnabled: cfg.SyncEnabled,
		Policy:      h.policy(cfg),
		Account:     account,
	})
}

func (h *Handlers) telegramQRStart(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}
	subj := auth.MustSubject(r.Context())
	var out telegramQRLogin
	if err := h.workerJSON(r.Context(), cfg, http.MethodPost, "/telegram/qr/start", map[string]any{
		"user_id":  subj.UserID.String(),
		"api_id":   cfg.APIID,
		"api_hash": cfg.APIHash,
	}, &out); err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out.public())
}

func (h *Handlers) telegramQRPoll(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}
	loginID := chi.URLParam(r, "loginID")
	if loginID == "" {
		writeErr(w, http.StatusBadRequest, "bad_login_id", "login_id обязателен")
		return
	}

	var out telegramQRLogin
	if err := h.workerJSON(r.Context(), cfg, http.MethodGet, "/telegram/qr/"+loginID, nil, &out); err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}
	if out.Status == "confirmed" {
		subj := auth.MustSubject(r.Context())
		account, err := h.saveConfirmedTelegramSession(r.Context(), cfg, subj.UserID, out)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "telegram_session_save_failed", err.Error())
			return
		}
		out.Account = account
	}
	writeJSON(w, http.StatusOK, out.public())
}

func (h *Handlers) telegramDisconnect(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	_, err := h.db.Exec(r.Context(), `
		UPDATE messenger_account
		SET status='revoked', error_message=NULL, updated_at=NOW()
		WHERE user_id=$1 AND provider=$2
	`, subj.UserID, providerTelegram)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_disconnect_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) telegramSync(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}

	subj := auth.MustSubject(r.Context())
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_sync_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeErr(w, http.StatusConflict, "telegram_not_connected", "Telegram не подключён")
		return
	}

	session, err := h.loadTelegramSession(r.Context(), cfg, account.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_session_load_failed", err.Error())
		return
	}
	h.startTelegramUpdates(r.Context(), cfg, subj.UserID, account.ID, session)

	var workerOut workerSyncResponse
	if err := h.workerJSON(r.Context(), cfg, http.MethodPost, "/telegram/chats/sync", map[string]any{
		"api_id":   cfg.APIID,
		"api_hash": cfg.APIHash,
		"session":  session,
		"limit":    100,
	}, &workerOut); err != nil {
		_, _ = h.db.Exec(r.Context(), `
			UPDATE messenger_account
			SET status='error', error_message=$2, updated_at=NOW()
			WHERE id=$1
		`, account.ID, err.Error())
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}

	items, err := h.saveSyncedChats(r.Context(), account.ID, workerOut.Items)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_sync_save_failed", err.Error())
		return
	}
	syncedAt := time.Now()
	_, _ = h.db.Exec(r.Context(), `
		UPDATE messenger_account
		SET status='connected', error_message=NULL, last_sync_at=$2, updated_at=NOW()
		WHERE id=$1
	`, account.ID, syncedAt)
	writeJSON(w, http.StatusOK, telegramSyncResponse{Items: items, SyncedAt: syncedAt})
}

func (h *Handlers) telegramChats(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_chats_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeJSON(w, http.StatusOK, map[string]any{"items": []chatItem{}, "next_cursor": ""})
		return
	}

	limit := boundedInt(r.URL.Query().Get("limit"), 50, 1, 100)
	rows, err := h.db.Query(r.Context(), `
		SELECT id, provider_chat_id, type, title, unread_count, last_message_preview, last_message_at, muted, pinned
		FROM messenger_chat
		WHERE account_id=$1 AND type IN ('private', 'group')
		ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
		LIMIT $2
	`, account.ID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_chats_failed", err.Error())
		return
	}
	defer rows.Close()

	items := make([]chatItem, 0, limit)
	for rows.Next() {
		var item chatItem
		if err := rows.Scan(&item.ID, &item.ProviderChatID, &item.Type, &item.Title, &item.UnreadCount, &item.LastMessagePreview, &item.LastMessageAt, &item.Muted, &item.Pinned); err != nil {
			writeErr(w, http.StatusInternalServerError, "telegram_chats_failed", err.Error())
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_chats_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": ""})
}

func (h *Handlers) telegramChatSync(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}
	subj := auth.MustSubject(r.Context())
	chatID, err := uuid.Parse(chi.URLParam(r, "chatID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_chat_id", err.Error())
		return
	}
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_chat_sync_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeErr(w, http.StatusConflict, "telegram_not_connected", "Telegram не подключён")
		return
	}
	chat, err := h.loadChat(r.Context(), account.ID, chatID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "chat_not_found", "чат не найден")
		return
	}
	session, err := h.loadTelegramSession(r.Context(), cfg, account.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_session_load_failed", err.Error())
		return
	}
	h.startTelegramUpdates(r.Context(), cfg, subj.UserID, account.ID, session)
	var workerOut workerMessagesResponse
	if err := h.workerJSON(r.Context(), cfg, http.MethodPost, "/telegram/messages/sync", map[string]any{
		"api_id":           cfg.APIID,
		"api_hash":         cfg.APIHash,
		"session":          session,
		"provider_chat_id": chat.ProviderChatID,
		"limit":            50,
	}, &workerOut); err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}
	items, err := h.saveSyncedMessages(r.Context(), chatID, workerOut.Items)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_save_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": ""})
}

func (h *Handlers) telegramMessages(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	chatID, err := uuid.Parse(chi.URLParam(r, "chatID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_chat_id", err.Error())
		return
	}
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeErr(w, http.StatusConflict, "telegram_not_connected", "Telegram не подключён")
		return
	}

	var exists bool
	if err := h.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM messenger_chat WHERE id=$1 AND account_id=$2)
	`, chatID, account.ID).Scan(&exists); err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "chat_not_found", "чат не найден")
		return
	}

	limit := boundedInt(r.URL.Query().Get("limit"), 50, 1, 100)
	rows, err := h.db.Query(r.Context(), `
		SELECT id, direction, sender_name, text, status, sent_at
		FROM messenger_message
		WHERE chat_id=$1
		ORDER BY sent_at DESC
		LIMIT $2
	`, chatID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
		return
	}
	defer rows.Close()

	items := make([]messageItem, 0, limit)
	for rows.Next() {
		var item messageItem
		if err := rows.Scan(&item.ID, &item.Direction, &item.SenderName, &item.Text, &item.Status, &item.SentAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
		return
	}
	if err := h.hydrateAttachments(r.Context(), items); err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_messages_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": ""})
}

func (h *Handlers) telegramSendMessage(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}
	in, err := parseSendMessageRequest(w, r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_message", err.Error())
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" && len(in.Files) == 0 {
		writeErr(w, http.StatusBadRequest, "empty_message", "текст или вложение обязательны")
		return
	}
	if len([]rune(in.Text)) > 4096 {
		writeErr(w, http.StatusBadRequest, "message_too_long", "сообщение не должно быть длиннее 4096 символов")
		return
	}

	subj := auth.MustSubject(r.Context())
	chatID, err := uuid.Parse(chi.URLParam(r, "chatID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_chat_id", err.Error())
		return
	}
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_send_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeErr(w, http.StatusConflict, "telegram_not_connected", "Telegram не подключён")
		return
	}
	chat, err := h.loadChat(r.Context(), account.ID, chatID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "chat_not_found", "чат не найден")
		return
	}
	session, err := h.loadTelegramSession(r.Context(), cfg, account.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_session_load_failed", err.Error())
		return
	}
	h.startTelegramUpdates(r.Context(), cfg, subj.UserID, account.ID, session)

	var workerOut workerSendResponse
	if err := h.workerJSON(r.Context(), cfg, http.MethodPost, "/telegram/messages/send", map[string]any{
		"api_id":           cfg.APIID,
		"api_hash":         cfg.APIHash,
		"session":          session,
		"provider_chat_id": chat.ProviderChatID,
		"text":             in.Text,
		"files":            in.Files,
	}, &workerOut); err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}
	items, err := h.saveSyncedMessages(r.Context(), chatID, workerOut.Items)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_message_save_failed", err.Error())
		return
	}
	if len(items) == 0 {
		writeErr(w, http.StatusBadGateway, "telegram_send_failed", "Telegram не вернул отправленное сообщение")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handlers) telegramDownloadAttachment(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.telegramConfig(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_config_failed", err.Error())
		return
	}
	if !telegramConfigured(cfg) {
		writeErr(w, http.StatusServiceUnavailable, "telegram_not_configured", "Telegram API ID/API Hash/encryption key не настроены")
		return
	}
	attachmentID, err := uuid.Parse(chi.URLParam(r, "attachmentID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_attachment_id", err.Error())
		return
	}
	subj := auth.MustSubject(r.Context())
	account, err := h.loadTelegramAccount(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_attachment_failed", err.Error())
		return
	}
	if account == nil || account.Status != "connected" {
		writeErr(w, http.StatusConflict, "telegram_not_connected", "Telegram не подключён")
		return
	}

	var providerChatID, providerMessageID, fileName, mimeType string
	err = h.db.QueryRow(r.Context(), `
		SELECT mc.provider_chat_id, mm.provider_message_id, ma.file_name, ma.mime_type
		FROM messenger_attachment ma
		JOIN messenger_message mm ON mm.id=ma.message_id
		JOIN messenger_chat mc ON mc.id=mm.chat_id
		WHERE ma.id=$1 AND mc.account_id=$2
	`, attachmentID, account.ID).Scan(&providerChatID, &providerMessageID, &fileName, &mimeType)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, http.StatusNotFound, "attachment_not_found", "вложение не найдено")
			return
		}
		writeErr(w, http.StatusInternalServerError, "telegram_attachment_failed", err.Error())
		return
	}
	session, err := h.loadTelegramSession(r.Context(), cfg, account.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_session_load_failed", err.Error())
		return
	}
	var workerOut workerMediaDownloadResponse
	if err := h.workerJSON(r.Context(), cfg, http.MethodPost, "/telegram/media/download", map[string]any{
		"api_id":              cfg.APIID,
		"api_hash":            cfg.APIHash,
		"session":             session,
		"provider_chat_id":    providerChatID,
		"provider_message_id": providerMessageID,
	}, &workerOut); err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_worker_failed", err.Error())
		return
	}
	data, err := base64.StdEncoding.DecodeString(workerOut.Data)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "telegram_media_decode_failed", err.Error())
		return
	}
	if workerOut.FileName != "" {
		fileName = workerOut.FileName
	}
	if workerOut.MimeType != "" {
		mimeType = workerOut.MimeType
	}
	if fileName == "" {
		fileName = "telegram-attachment"
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if disposition := r.URL.Query().Get("disposition"); disposition == "attachment" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fileName}))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (h *Handlers) telegramWorkerUpdate(w http.ResponseWriter, r *http.Request) {
	var in workerUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	secret, ok := h.updateSecrets.Load(in.AccountID)
	if !ok || r.Header.Get("X-Toolkit-Telegram-Secret") == "" || r.Header.Get("X-Toolkit-Telegram-Secret") != secret.(string) {
		writeErr(w, http.StatusUnauthorized, "bad_secret", "invalid worker callback secret")
		return
	}

	var userID uuid.UUID
	var chatID uuid.UUID
	err := h.db.QueryRow(r.Context(), `
		SELECT ma.user_id, mc.id
		FROM messenger_account ma
		JOIN messenger_chat mc ON mc.account_id=ma.id
		WHERE ma.id=$1 AND mc.provider_chat_id=$2 AND ma.provider=$3
	`, in.AccountID, in.ProviderChatID, providerTelegram).Scan(&userID, &chatID)
	if err != nil {
		if err == pgx.ErrNoRows {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeErr(w, http.StatusInternalServerError, "telegram_update_failed", err.Error())
		return
	}

	items, err := h.saveSyncedMessages(r.Context(), chatID, []workerMessage{in.Message})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "telegram_update_save_failed", err.Error())
		return
	}
	if len(items) > 0 && h.hub != nil {
		payload, _ := json.Marshal(map[string]any{
			"chat_id":          chatID,
			"account_id":       in.AccountID,
			"provider_chat_id": in.ProviderChatID,
			"message":          items[0],
		})
		h.hub.Publish(userID, ws.Event{Type: "messenger.message.created", Payload: payload})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) loadTelegramAccount(r *http.Request, userID uuid.UUID) (*telegramAccount, error) {
	var account telegramAccount
	err := h.db.QueryRow(r.Context(), `
		SELECT id, display_name, username, phone_masked, status, COALESCE(error_message, ''), connected_at, last_sync_at
		FROM messenger_account
		WHERE user_id=$1 AND provider=$2
	`, userID, providerTelegram).Scan(
		&account.ID, &account.DisplayName, &account.Username, &account.PhoneMasked,
		&account.Status, &account.ErrorMessage, &account.ConnectedAt, &account.LastSyncAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &account, nil
}

func (h *Handlers) loadChat(ctx context.Context, accountID, chatID uuid.UUID) (*chatItem, error) {
	var chat chatItem
	err := h.db.QueryRow(ctx, `
		SELECT id, provider_chat_id, type, title, unread_count, last_message_preview, last_message_at, muted, pinned
		FROM messenger_chat
		WHERE id=$1 AND account_id=$2
	`, chatID, accountID).Scan(
		&chat.ID, &chat.ProviderChatID, &chat.Type, &chat.Title, &chat.UnreadCount, &chat.LastMessagePreview, &chat.LastMessageAt, &chat.Muted, &chat.Pinned,
	)
	if err != nil {
		return nil, err
	}
	return &chat, nil
}

func (h *Handlers) loadTelegramSession(ctx context.Context, cfg sysset.TelegramConfig, accountID uuid.UUID) (string, error) {
	var encrypted string
	if err := h.db.QueryRow(ctx, `
		SELECT session_encrypted
		FROM messenger_telegram_session
		WHERE account_id=$1
	`, accountID).Scan(&encrypted); err != nil {
		return "", err
	}
	return decryptTelegramSession(cfg.SessionEncryptionKey, encrypted)
}

func (h *Handlers) saveSyncedChats(ctx context.Context, accountID uuid.UUID, chats []workerSyncChat) ([]chatItem, error) {
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := make([]chatItem, 0, len(chats))
	for _, chat := range chats {
		if chat.ProviderChatID == "" || (chat.Type != "private" && chat.Type != "group") {
			continue
		}
		if chat.Title == "" {
			chat.Title = "Без названия"
		}
		var item chatItem
		err := tx.QueryRow(ctx, `
			INSERT INTO messenger_chat
				(account_id, provider_chat_id, type, title, unread_count, last_message_at, last_message_preview, pinned, muted, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
			ON CONFLICT (account_id, provider_chat_id)
			DO UPDATE SET
				type=EXCLUDED.type,
				title=EXCLUDED.title,
				unread_count=EXCLUDED.unread_count,
				last_message_at=EXCLUDED.last_message_at,
				last_message_preview=EXCLUDED.last_message_preview,
				pinned=EXCLUDED.pinned,
				muted=EXCLUDED.muted,
				updated_at=NOW()
			RETURNING id, provider_chat_id, type, title, unread_count, last_message_preview, last_message_at, muted, pinned
		`, accountID, chat.ProviderChatID, chat.Type, chat.Title, chat.UnreadCount, chat.LastMessageAt, chat.LastMessagePreview, chat.Pinned, chat.Muted).Scan(
			&item.ID, &item.ProviderChatID, &item.Type, &item.Title, &item.UnreadCount, &item.LastMessagePreview, &item.LastMessageAt, &item.Muted, &item.Pinned,
		)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (h *Handlers) saveSyncedMessages(ctx context.Context, chatID uuid.UUID, messages []workerMessage) ([]messageItem, error) {
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := make([]messageItem, 0, len(messages))
	for _, msg := range messages {
		if msg.ProviderMessageID == "" || msg.SentAt.IsZero() {
			continue
		}
		if msg.Direction != "out" {
			msg.Direction = "in"
		}
		if msg.Status == "" {
			msg.Status = "sent"
		}
		raw := msg.Raw
		if len(raw) == 0 {
			raw = json.RawMessage(`{}`)
		}
		var item messageItem
		err := tx.QueryRow(ctx, `
			INSERT INTO messenger_message
				(chat_id, provider_message_id, direction, sender_provider_id, sender_name, text, status, sent_at, raw, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
			ON CONFLICT (chat_id, provider_message_id)
			DO UPDATE SET
				direction=EXCLUDED.direction,
				sender_provider_id=EXCLUDED.sender_provider_id,
				sender_name=EXCLUDED.sender_name,
				text=EXCLUDED.text,
				status=EXCLUDED.status,
				sent_at=EXCLUDED.sent_at,
				raw=EXCLUDED.raw,
				updated_at=NOW()
			RETURNING id, direction, sender_name, text, status, sent_at
		`, chatID, msg.ProviderMessageID, msg.Direction, msg.SenderProviderID, msg.SenderName, msg.Text, msg.Status, msg.SentAt, raw).Scan(
			&item.ID, &item.Direction, &item.SenderName, &item.Text, &item.Status, &item.SentAt,
		)
		if err != nil {
			return nil, err
		}
		item.Attachments = []attachmentItem{}
		if _, err := tx.Exec(ctx, `DELETE FROM messenger_attachment WHERE message_id=$1`, item.ID); err != nil {
			return nil, err
		}
		for _, att := range msg.Attachments {
			if att.ProviderFileID == "" && att.FileName == "" && att.MimeType == "" {
				continue
			}
			kind := normalizeAttachmentKind(att.Kind)
			var saved attachmentItem
			err := tx.QueryRow(ctx, `
				INSERT INTO messenger_attachment
					(message_id, provider_file_id, kind, file_name, mime_type, size_bytes, width, height, duration_sec)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				RETURNING id, kind, file_name, mime_type, size_bytes, width, height, duration_sec
			`, item.ID, att.ProviderFileID, kind, att.FileName, att.MimeType, att.SizeBytes, att.Width, att.Height, att.DurationSec).Scan(
				&saved.ID, &saved.Kind, &saved.FileName, &saved.MimeType, &saved.SizeBytes, &saved.Width, &saved.Height, &saved.DurationSec,
			)
			if err != nil {
				return nil, err
			}
			saved.DownloadURL = "/api/v1/messenger/telegram/attachments/" + saved.ID.String() + "/download"
			item.Attachments = append(item.Attachments, saved)
		}
		out = append(out, item)
	}

	if len(out) > 0 {
		last := out[0]
		for _, item := range out[1:] {
			if item.SentAt.After(last.SentAt) {
				last = item
			}
		}
		preview := last.Text
		if preview == "" && len(last.Attachments) > 0 {
			preview = attachmentPreview(last.Attachments[0])
		}
		if len([]rune(preview)) > 160 {
			preview = string([]rune(preview)[:157]) + "..."
		}
		_, _ = tx.Exec(ctx, `
			UPDATE messenger_chat
			SET last_message_preview=$2, last_message_at=$3, updated_at=NOW()
			WHERE id=$1
		`, chatID, preview, last.SentAt)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (h *Handlers) startTelegramUpdates(ctx context.Context, cfg sysset.TelegramConfig, userID, accountID uuid.UUID, session string) {
	if h.hub == nil || session == "" {
		return
	}
	secret, err := randomSecret()
	if err != nil {
		return
	}
	h.updateSecrets.Store(accountID, secret)
	var out map[string]any
	_ = h.workerJSON(ctx, cfg, http.MethodPost, "/telegram/updates/start", map[string]any{
		"api_id":          cfg.APIID,
		"api_hash":        cfg.APIHash,
		"session":         session,
		"account_id":      accountID.String(),
		"user_id":         userID.String(),
		"callback_url":    "http://api:8080/api/v1/messenger-internal/telegram/updates",
		"callback_secret": secret,
	}, &out)
}

func parseSendMessageRequest(w http.ResponseWriter, r *http.Request) (sendMessageRequest, error) {
	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, maxTelegramUploadBytes+8*1024*1024)
		if err := r.ParseMultipartForm(maxTelegramUploadBytes); err != nil {
			return sendMessageRequest{}, err
		}
		defer func() {
			if r.MultipartForm != nil {
				_ = r.MultipartForm.RemoveAll()
			}
		}()
		out := sendMessageRequest{Text: r.FormValue("text")}
		if r.MultipartForm == nil {
			return out, nil
		}
		headers := r.MultipartForm.File["files"]
		if len(headers) == 0 {
			headers = r.MultipartForm.File["file"]
		}
		for _, header := range headers {
			if header.Size > maxTelegramUploadBytes {
				return sendMessageRequest{}, fmt.Errorf("файл %s больше лимита 50 МБ", header.Filename)
			}
			file, err := header.Open()
			if err != nil {
				return sendMessageRequest{}, err
			}
			data, err := io.ReadAll(io.LimitReader(file, maxTelegramUploadBytes+1))
			_ = file.Close()
			if err != nil {
				return sendMessageRequest{}, err
			}
			if len(data) > maxTelegramUploadBytes {
				return sendMessageRequest{}, fmt.Errorf("файл %s больше лимита 50 МБ", header.Filename)
			}
			mimeType := header.Header.Get("Content-Type")
			if mimeType == "" {
				mimeType = http.DetectContentType(data)
			}
			out.Files = append(out.Files, workerUploadFile{
				FileName: safeFileName(header.Filename),
				MimeType: mimeType,
				Data:     base64.StdEncoding.EncodeToString(data),
			})
		}
		return out, nil
	}

	var out sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		return sendMessageRequest{}, err
	}
	return out, nil
}

func (h *Handlers) hydrateAttachments(ctx context.Context, messages []messageItem) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(messages))
	index := make(map[uuid.UUID]int, len(messages))
	for i := range messages {
		messages[i].Attachments = []attachmentItem{}
		ids = append(ids, messages[i].ID)
		index[messages[i].ID] = i
	}
	rows, err := h.db.Query(ctx, `
		SELECT id, message_id, kind, file_name, mime_type, size_bytes, width, height, duration_sec
		FROM messenger_attachment
		WHERE message_id = ANY($1)
		ORDER BY created_at ASC
	`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID uuid.UUID
		var item attachmentItem
		if err := rows.Scan(&item.ID, &messageID, &item.Kind, &item.FileName, &item.MimeType, &item.SizeBytes, &item.Width, &item.Height, &item.DurationSec); err != nil {
			return err
		}
		item.DownloadURL = "/api/v1/messenger/telegram/attachments/" + item.ID.String() + "/download"
		if pos, ok := index[messageID]; ok {
			messages[pos].Attachments = append(messages[pos].Attachments, item)
		}
	}
	return rows.Err()
}

func normalizeAttachmentKind(kind string) string {
	switch kind {
	case "photo", "document", "audio", "voice", "video", "sticker":
		return kind
	default:
		return "unknown"
	}
}

func attachmentPreview(att attachmentItem) string {
	switch att.Kind {
	case "photo":
		return "Фото"
	case "video":
		return "Видео"
	case "audio":
		return "Аудио"
	case "voice":
		return "Голосовое сообщение"
	case "sticker":
		return "Стикер"
	default:
		if att.FileName != "" {
			return "Файл: " + att.FileName
		}
		return "Вложение"
	}
}

func safeFileName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == "/" || name == "" {
		return "attachment"
	}
	return name
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (h *Handlers) telegramConfig(ctx context.Context) (sysset.TelegramConfig, error) {
	return sysset.LoadTelegramRuntimeConfig(ctx, h.db, sysset.TelegramConfig{
		APIID:                h.cfg.TelegramAPIID,
		APIHash:              h.cfg.TelegramAPIHash,
		SessionEncryptionKey: h.cfg.TelegramSessionEncryptionKey,
		WorkerURL:            h.cfg.TelegramWorkerURL,
		SyncEnabled:          h.cfg.TelegramSyncEnabled,
		RetentionDays:        h.cfg.TelegramRetentionDays,
	})
}

func telegramConfigured(cfg sysset.TelegramConfig) bool {
	return cfg.APIID > 0 && cfg.APIHash != "" && cfg.SessionEncryptionKey != "" && cfg.WorkerURL != ""
}

func (h *Handlers) saveConfirmedTelegramSession(ctx context.Context, cfg sysset.TelegramConfig, userID uuid.UUID, login telegramQRLogin) (*telegramAccount, error) {
	if login.Session == "" {
		return nil, fmt.Errorf("worker returned confirmed login without session")
	}
	if login.Account == nil || login.Account.ProviderUserID == "" {
		return nil, fmt.Errorf("worker returned confirmed login without account")
	}

	encrypted, fingerprint, err := encryptTelegramSession(cfg.SessionEncryptionKey, login.Session)
	if err != nil {
		return nil, err
	}

	acc := login.Account
	if acc.Status == "" {
		acc.Status = "connected"
	}
	if acc.DisplayName == "" {
		acc.DisplayName = "Telegram"
	}

	var accountID uuid.UUID
	err = h.db.QueryRow(ctx, `
		INSERT INTO messenger_account
			(user_id, provider, provider_user_id, display_name, username, phone_masked, status, error_message, connected_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'connected', NULL, NOW(), NOW())
		ON CONFLICT (user_id, provider)
		DO UPDATE SET
			provider_user_id=EXCLUDED.provider_user_id,
			display_name=EXCLUDED.display_name,
			username=EXCLUDED.username,
			phone_masked=EXCLUDED.phone_masked,
			status='connected',
			error_message=NULL,
			connected_at=COALESCE(messenger_account.connected_at, NOW()),
			updated_at=NOW()
		RETURNING id
	`, userID, providerTelegram, acc.ProviderUserID, acc.DisplayName, acc.Username, acc.PhoneMasked).Scan(&accountID)
	if err != nil {
		return nil, err
	}

	_, err = h.db.Exec(ctx, `
		INSERT INTO messenger_telegram_session
			(account_id, session_encrypted, session_fingerprint, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (account_id)
		DO UPDATE SET
			session_encrypted=EXCLUDED.session_encrypted,
			session_fingerprint=EXCLUDED.session_fingerprint,
			updated_at=NOW()
	`, accountID, encrypted, fingerprint)
	if err != nil {
		return nil, err
	}

	acc.ID = accountID
	acc.Status = "connected"
	now := time.Now()
	acc.ConnectedAt = &now
	return acc, nil
}

func (h *Handlers) workerJSON(ctx context.Context, cfg sysset.TelegramConfig, method, path string, body any, out any) error {
	url := strings.TrimRight(cfg.WorkerURL, "/") + path
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var payload struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&payload)
		if payload.Error.Message != "" {
			return fmt.Errorf("%s: %s", payload.Error.Code, payload.Error.Message)
		}
		return fmt.Errorf("worker returned HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func encryptTelegramSession(secret, value string) (string, string, error) {
	key, err := telegramEncryptionKey(secret)
	if err != nil {
		return "", "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)
	blob := append(nonce, ciphertext...)
	sum := sha256.Sum256([]byte(value))
	return base64.StdEncoding.EncodeToString(blob), base64.StdEncoding.EncodeToString(sum[:]), nil
}

func decryptTelegramSession(secret, value string) (string, error) {
	key, err := telegramEncryptionKey(secret)
	if err != nil {
		return "", err
	}
	blob, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(blob) <= gcm.NonceSize() {
		return "", fmt.Errorf("encrypted Telegram session is too short")
	}
	nonce := blob[:gcm.NonceSize()]
	ciphertext := blob[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func telegramEncryptionKey(secret string) ([]byte, error) {
	if raw, err := base64.StdEncoding.DecodeString(secret); err == nil && len(raw) == 32 {
		return raw, nil
	}
	if raw, err := base64.RawStdEncoding.DecodeString(secret); err == nil && len(raw) == 32 {
		return raw, nil
	}
	if len(secret) == 32 {
		return []byte(secret), nil
	}
	return nil, fmt.Errorf("TELEGRAM_SESSION_ENCRYPTION_KEY должен быть 32 байта или base64 от 32 байт")
}

func (h *Handlers) policy(cfg sysset.TelegramConfig) telegramPolicy {
	return telegramPolicy{
		ReuseAllowed:      true,
		RetentionDays:     cfg.RetentionDays,
		SyncPrivateChats:  true,
		SyncGroups:        true,
		SyncChannels:      false,
		InitialCacheLimit: 500,
	}
}

func boundedInt(raw string, def, min, max int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return def
	}
	return n
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{"error": map[string]any{"code": errCode, "message": message}})
}
