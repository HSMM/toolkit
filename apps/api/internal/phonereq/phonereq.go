// Package phonereq реализует заявки пользователей на закрепление внутреннего
// номера (extension'а FreePBX). Заявка создаётся пользователем без extension'а,
// админ закрывает заявку approve'ом (с указанием ext) или reject'ом.
//
// Хранение:
//   - Сами заявки — таблица phone_extension_request (миграция 000016).
//   - Привязки extension <-> user — JSONB в system_setting/phone_config
//     (тот же ключ, что использует sysset). При approve мы читаем/пишем
//     этот JSONB через row-lock + advisory_xact_lock на ключе.
//
// Уведомления: на create/cancel — broadcast всем admin'ам через Hub.PublishToRole;
// на approve/reject — Publish конкретному пользователю-заявителю.
package phonereq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/ws"
)

const (
	StatusPending   = "pending"
	StatusApproved  = "approved"
	StatusRejected  = "rejected"
	StatusCancelled = "cancelled"

	EventCreated   = "phone_extension_request_created"
	EventCancelled = "phone_extension_request_cancelled"
	EventResolved  = "phone_extension_request_resolved"

	maxCommentLen = 500
	maxReasonLen  = 500
)

// extension в FreePBX — 2-6 цифр (та же валидация, что в админке Settings → Phone).
var extRegexp = regexp.MustCompile(`^\d{2,6}$`)

// phoneExtension — одна запись в phone_config.extensions[]. Структура должна
// совпадать с sysset.PhoneExtension; локальное определение используется чтобы
// не тянуть лишнюю зависимость на пакет sysset.
type phoneExtension struct {
	Ext        string  `json:"ext"`
	Password   string  `json:"password,omitempty"`
	AssignedTo *string `json:"assigned_to,omitempty"`
}

type phoneConfig struct {
	WssURL     string           `json:"wss_url"`
	Extensions []phoneExtension `json:"extensions"`
}

// ──────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────

type Service struct {
	db  *pgxpool.Pool
	hub *ws.Hub
	log *slog.Logger
}

func NewService(db *pgxpool.Pool, hub *ws.Hub, log *slog.Logger) *Service {
	return &Service{db: db, hub: hub, log: log}
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP layer
// ──────────────────────────────────────────────────────────────────────────

type Handlers struct {
	s *Service
}

func NewHandlers(s *Service) *Handlers { return &Handlers{s: s} }

// MyRoutes монтируется под /api/v1/phone/extension-requests. Только auth, не admin.
func (h *Handlers) MyRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/me", h.getMy)
	r.Post("/", h.create)
	r.Delete("/me", h.cancelMy)
	return r
}

// AdminRoutes монтируется под /api/v1/admin/phone/extension-requests. RequireRole(admin).
func (h *Handlers) AdminRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/{id}/approve", h.approve)
	r.Post("/{id}/reject", h.reject)
	return r
}

// ──────────────────────────────────────────────────────────────────────────
// User-side handlers
// ──────────────────────────────────────────────────────────────────────────

type myRequestResponse struct {
	Request *requestRow `json:"request"`
}

type requestRow struct {
	ID                uuid.UUID  `json:"id"`
	UserID            uuid.UUID  `json:"user_id"`
	Status            string     `json:"status"`
	Comment           string     `json:"comment,omitempty"`
	RejectReason      string     `json:"reject_reason,omitempty"`
	AssignedExtension string     `json:"assigned_extension,omitempty"`
	ResolvedAt        *time.Time `json:"resolved_at,omitempty"`
	ResolvedBy        *uuid.UUID `json:"resolved_by,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
}

// getMy возвращает САМУЮ свежую заявку текущего пользователя (или null).
func (h *Handlers) getMy(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	row, err := loadLatestForUser(r.Context(), h.s.db, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, myRequestResponse{Request: row})
}

type createReq struct {
	Comment string `json:"comment"`
}

// create — пользователь создаёт заявку. 409 если уже привязан extension или есть активная заявка.
func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())

	var in createReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	comment := truncRunes(strings.TrimSpace(in.Comment), maxCommentLen)

	// 1. Проверка: уже есть привязанный extension?
	cfg, err := loadPhoneConfig(r.Context(), h.s.db)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	uid := subj.UserID.String()
	for _, e := range cfg.Extensions {
		if e.AssignedTo != nil && *e.AssignedTo == uid {
			writeErr(w, http.StatusConflict, "already_assigned",
				"за вами уже закреплён внутренний номер")
			return
		}
	}

	// 2. INSERT — UNIQUE-индекс по pending защищает от дубля.
	const q = `
		INSERT INTO phone_extension_request (user_id, status, comment)
		VALUES ($1, 'pending', NULLIF($2, ''))
		RETURNING id, user_id, status, COALESCE(comment, ''), COALESCE(reject_reason, ''),
		          COALESCE(assigned_extension, ''), resolved_at, resolved_by, created_at
	`
	var row requestRow
	err = h.s.db.QueryRow(r.Context(), q, subj.UserID, comment).Scan(
		&row.ID, &row.UserID, &row.Status, &row.Comment, &row.RejectReason,
		&row.AssignedExtension, &row.ResolvedAt, &row.ResolvedBy, &row.CreatedAt,
	)
	if err != nil {
		// pgx 23505 = unique_violation → активная заявка уже есть.
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "already_pending",
				"у вас уже есть активная заявка на номер")
			return
		}
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}

	// 3. Загрузить публичные поля пользователя для WS-payload админам.
	user, err := loadUserBrief(r.Context(), h.s.db, subj.UserID)
	if err == nil {
		h.s.publishToAdmins(EventCreated, map[string]any{
			"request_id": row.ID,
			"user_id":    row.UserID,
			"user":       user,
			"comment":    row.Comment,
			"created_at": row.CreatedAt,
		})
	}

	writeJSON(w, http.StatusCreated, row)
}

// cancelMy — пользователь отзывает свою активную заявку.
func (h *Handlers) cancelMy(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())

	const q = `
		UPDATE phone_extension_request
		SET status='cancelled', resolved_at=NOW(), resolved_by=$1
		WHERE user_id=$1 AND status='pending'
		RETURNING id
	`
	var id uuid.UUID
	err := h.s.db.QueryRow(r.Context(), q, subj.UserID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "активной заявки не найдено")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}

	h.s.publishToAdmins(EventCancelled, map[string]any{"request_id": id})

	w.WriteHeader(http.StatusNoContent)
}

// ──────────────────────────────────────────────────────────────────────────
// Admin-side handlers
// ──────────────────────────────────────────────────────────────────────────

type userBrief struct {
	ID         uuid.UUID `json:"id"`
	FullName   string    `json:"full_name"`
	Email      string    `json:"email"`
	Department string    `json:"department,omitempty"`
	Position   string    `json:"position,omitempty"`
}

type adminRequestRow struct {
	requestRow
	User           userBrief `json:"user"`
	ResolvedByName string    `json:"resolved_by_name,omitempty"`
}

type listResponse struct {
	Items        []adminRequestRow `json:"items"`
	Total        int               `json:"total"`
	PendingCount int               `json:"pending_count"`
}

// list — админский список заявок с фильтром по статусу.
//   ?status=pending  → только активные (default)
//   ?status=history  → все resolved (approved + rejected + cancelled)
//   ?status=all      → всё
func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	statusFilter := r.URL.Query().Get("status")
	if statusFilter == "" {
		statusFilter = "pending"
	}
	limit := parseIntDefault(r.URL.Query().Get("limit"), 50, 1, 200)
	offset := parseIntDefault(r.URL.Query().Get("offset"), 0, 0, 1<<31)

	statuses, err := statusFilterToList(statusFilter)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_status", err.Error())
		return
	}

	const q = `
		SELECT
		    r.id, r.user_id, r.status, COALESCE(r.comment, ''),
		    COALESCE(r.reject_reason, ''), COALESCE(r.assigned_extension, ''),
		    r.resolved_at, r.resolved_by, r.created_at,
		    u.full_name, u.email, COALESCE(u.department, ''), COALESCE(u.position, ''),
		    COALESCE(rb.full_name, '')
		FROM phone_extension_request r
		JOIN "user" u ON u.id = r.user_id
		LEFT JOIN "user" rb ON rb.id = r.resolved_by
		WHERE r.status = ANY($1::text[])
		ORDER BY r.created_at DESC
		LIMIT $2 OFFSET $3
	`
	rows, err := h.s.db.Query(r.Context(), q, statuses, limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	defer rows.Close()

	out := make([]adminRequestRow, 0, 32)
	for rows.Next() {
		var a adminRequestRow
		if err := rows.Scan(
			&a.ID, &a.UserID, &a.Status, &a.Comment,
			&a.RejectReason, &a.AssignedExtension,
			&a.ResolvedAt, &a.ResolvedBy, &a.CreatedAt,
			&a.User.FullName, &a.User.Email, &a.User.Department, &a.User.Position,
			&a.ResolvedByName,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan_failed", err.Error())
			return
		}
		a.User.ID = a.UserID
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "scan_failed", err.Error())
		return
	}

	// total — по тому же фильтру, для пагинации в UI.
	var total int
	if err := h.s.db.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM phone_extension_request WHERE status = ANY($1::text[])`,
		statuses,
	).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "count_failed", err.Error())
		return
	}

	// pending_count — всегда, независимо от фильтра, чтобы UI обновлял бейдж.
	var pendingCount int
	if err := h.s.db.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM phone_extension_request WHERE status='pending'`,
	).Scan(&pendingCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "count_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, listResponse{
		Items: out, Total: total, PendingCount: pendingCount,
	})
}

type approveReq struct {
	Ext      string `json:"ext"`
	Password string `json:"password"`
}

// approve — админ одобряет заявку, привязывая extension к заявителю.
//
// Транзакционно:
//   1. SELECT FOR UPDATE заявки → проверка status='pending'.
//   2. SELECT user.status → проверка active.
//   3. SELECT phone_config FOR UPDATE (row-lock на system_setting row).
//   4. Найти/добавить extension в JSON, проставить assigned_to.
//   5. UPDATE system_setting (записать обратно).
//   6. UPDATE заявки → status='approved'.
//   7. COMMIT → publish WS-event заявителю.
func (h *Handlers) approve(w http.ResponseWriter, r *http.Request) {
	admin := auth.MustSubject(r.Context())

	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid request id")
		return
	}

	var in approveReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	in.Ext = strings.TrimSpace(in.Ext)
	if !extRegexp.MatchString(in.Ext) {
		writeErr(w, http.StatusBadRequest, "invalid_ext",
			"extension должен быть числом 2-6 цифр")
		return
	}

	tx, err := h.s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "tx_begin_failed", err.Error())
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	// (1) Lock the request row.
	var (
		userID    uuid.UUID
		curStatus string
	)
	const reqQ = `
		SELECT user_id, status FROM phone_extension_request
		WHERE id=$1 FOR UPDATE
	`
	if err := tx.QueryRow(r.Context(), reqQ, id).Scan(&userID, &curStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "заявка не найдена")
			return
		}
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	if curStatus != StatusPending {
		writeErr(w, http.StatusConflict, "not_pending",
			"заявка уже резолвлена ("+curStatus+")")
		return
	}

	// (2) Verify user is active.
	var (
		uStatus      string
		deletedInBx  bool
	)
	if err := tx.QueryRow(r.Context(),
		`SELECT status, deleted_in_bx24 FROM "user" WHERE id=$1`, userID,
	).Scan(&uStatus, &deletedInBx); err != nil {
		writeErr(w, http.StatusInternalServerError, "load_user_failed", err.Error())
		return
	}
	if uStatus != "active" || deletedInBx {
		writeErr(w, http.StatusConflict, "user_inactive",
			"пользователь деактивирован, назначение невозможно")
		return
	}

	// (3) Acquire advisory xact lock on phone_config (defends against concurrent
	// admin save in sysset.putPhone, which doesn't take a row-level lock).
	if _, err := tx.Exec(r.Context(),
		`SELECT pg_advisory_xact_lock(hashtext('phone_config'))`,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "lock_failed", err.Error())
		return
	}

	// Read current phone_config (may not exist on first install — treat as empty).
	var raw []byte
	err = tx.QueryRow(r.Context(),
		`SELECT value FROM system_setting WHERE key='phone_config'`,
	).Scan(&raw)
	cfg := phoneConfig{Extensions: []phoneExtension{}}
	if err == nil {
		_ = json.Unmarshal(raw, &cfg)
		if cfg.Extensions == nil {
			cfg.Extensions = []phoneExtension{}
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "load_phone_failed", err.Error())
		return
	}

	// (4) Find/add extension and set assigned_to.
	uidStr := userID.String()
	found := -1
	for i := range cfg.Extensions {
		if cfg.Extensions[i].Ext == in.Ext {
			found = i
			break
		}
	}
	switch {
	case found >= 0:
		// Existing extension. Verify free or already mine.
		if cfg.Extensions[found].AssignedTo != nil && *cfg.Extensions[found].AssignedTo != uidStr {
			writeErr(w, http.StatusConflict, "ext_already_assigned",
				"номер уже назначен другому пользователю")
			return
		}
		if in.Password != "" {
			cfg.Extensions[found].Password = in.Password
		}
		cfg.Extensions[found].AssignedTo = &uidStr
	default:
		// New extension. Password обязателен.
		if in.Password == "" {
			writeErr(w, http.StatusBadRequest, "password_required",
				"для нового номера нужно указать пароль")
			return
		}
		cfg.Extensions = append([]phoneExtension{{
			Ext: in.Ext, Password: in.Password, AssignedTo: &uidStr,
		}}, cfg.Extensions...)
	}

	// (5) Persist phone_config.
	body, _ := json.Marshal(cfg)
	const saveCfg = `
		INSERT INTO system_setting (key, value, updated_by, updated_at)
		VALUES ('phone_config', $1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
	`
	if _, err := tx.Exec(r.Context(), saveCfg, body, admin.UserID); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_phone_failed", err.Error())
		return
	}

	// (6) Mark request approved.
	const updReq = `
		UPDATE phone_extension_request
		SET status='approved', assigned_extension=$2, resolved_at=NOW(), resolved_by=$3
		WHERE id=$1 AND status='pending'
		RETURNING id, user_id, status, COALESCE(comment, ''),
		          COALESCE(reject_reason, ''), COALESCE(assigned_extension, ''),
		          resolved_at, resolved_by, created_at
	`
	var row requestRow
	if err := tx.QueryRow(r.Context(), updReq, id, in.Ext, admin.UserID).Scan(
		&row.ID, &row.UserID, &row.Status, &row.Comment,
		&row.RejectReason, &row.AssignedExtension,
		&row.ResolvedAt, &row.ResolvedBy, &row.CreatedAt,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_request_failed", err.Error())
		return
	}

	// (7) Commit and publish.
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit_failed", err.Error())
		return
	}

	h.s.publishToUser(userID, EventResolved, map[string]any{
		"request_id":         row.ID,
		"status":             StatusApproved,
		"assigned_extension": in.Ext,
	})

	writeJSON(w, http.StatusOK, row)
}

type rejectReq struct {
	Reason string `json:"reason"`
}

// reject — админ отклоняет заявку.
func (h *Handlers) reject(w http.ResponseWriter, r *http.Request) {
	admin := auth.MustSubject(r.Context())

	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid request id")
		return
	}

	var in rejectReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	reason := truncRunes(strings.TrimSpace(in.Reason), maxReasonLen)

	const q = `
		UPDATE phone_extension_request
		SET status='rejected', reject_reason=NULLIF($2, ''),
		    resolved_at=NOW(), resolved_by=$3
		WHERE id=$1 AND status='pending'
		RETURNING id, user_id, status, COALESCE(comment, ''),
		          COALESCE(reject_reason, ''), COALESCE(assigned_extension, ''),
		          resolved_at, resolved_by, created_at
	`
	var row requestRow
	err = h.s.db.QueryRow(r.Context(), q, id, reason, admin.UserID).Scan(
		&row.ID, &row.UserID, &row.Status, &row.Comment,
		&row.RejectReason, &row.AssignedExtension,
		&row.ResolvedAt, &row.ResolvedBy, &row.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// Может быть либо not_found, либо уже резолвлено — отличаем доп. запросом.
		var s string
		if err2 := h.s.db.QueryRow(r.Context(),
			`SELECT status FROM phone_extension_request WHERE id=$1`, id,
		).Scan(&s); err2 != nil {
			writeErr(w, http.StatusNotFound, "not_found", "заявка не найдена")
			return
		}
		writeErr(w, http.StatusConflict, "not_pending",
			"заявка уже резолвлена ("+s+")")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}

	h.s.publishToUser(row.UserID, EventResolved, map[string]any{
		"request_id":    row.ID,
		"status":        StatusRejected,
		"reject_reason": row.RejectReason,
	})

	writeJSON(w, http.StatusOK, row)
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

func loadLatestForUser(ctx context.Context, db *pgxpool.Pool, userID uuid.UUID) (*requestRow, error) {
	const q = `
		SELECT id, user_id, status, COALESCE(comment, ''),
		       COALESCE(reject_reason, ''), COALESCE(assigned_extension, ''),
		       resolved_at, resolved_by, created_at
		FROM phone_extension_request
		WHERE user_id=$1
		ORDER BY created_at DESC
		LIMIT 1
	`
	var row requestRow
	err := db.QueryRow(ctx, q, userID).Scan(
		&row.ID, &row.UserID, &row.Status, &row.Comment,
		&row.RejectReason, &row.AssignedExtension,
		&row.ResolvedAt, &row.ResolvedBy, &row.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func loadUserBrief(ctx context.Context, db *pgxpool.Pool, userID uuid.UUID) (userBrief, error) {
	var u userBrief
	const q = `
		SELECT id, full_name, email, COALESCE(department, ''), COALESCE(position, '')
		FROM "user" WHERE id=$1
	`
	if err := db.QueryRow(ctx, q, userID).Scan(
		&u.ID, &u.FullName, &u.Email, &u.Department, &u.Position,
	); err != nil {
		return u, err
	}
	return u, nil
}

func loadPhoneConfig(ctx context.Context, db *pgxpool.Pool) (phoneConfig, error) {
	cfg := phoneConfig{Extensions: []phoneExtension{}}
	var raw []byte
	err := db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='phone_config'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		// Повреждённая запись — не валим, возвращаем пустую (как в sysset).
		return phoneConfig{Extensions: []phoneExtension{}}, nil
	}
	if cfg.Extensions == nil {
		cfg.Extensions = []phoneExtension{}
	}
	return cfg, nil
}

func (s *Service) publishToAdmins(eventType string, payload any) {
	if s.hub == nil {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		s.log.Warn("phonereq: marshal ws payload failed", "type", eventType, "err", err)
		return
	}
	s.hub.PublishToRole(string(auth.RoleAdmin), ws.Event{Type: eventType, Payload: body})
}

func (s *Service) publishToUser(userID uuid.UUID, eventType string, payload any) {
	if s.hub == nil {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		s.log.Warn("phonereq: marshal ws payload failed", "type", eventType, "err", err)
		return
	}
	s.hub.Publish(userID, ws.Event{Type: eventType, Payload: body})
}

func statusFilterToList(filter string) ([]string, error) {
	switch filter {
	case "pending":
		return []string{StatusPending}, nil
	case "history":
		return []string{StatusApproved, StatusRejected, StatusCancelled}, nil
	case "all":
		return []string{StatusPending, StatusApproved, StatusRejected, StatusCancelled}, nil
	default:
		return nil, fmt.Errorf("неизвестный фильтр: %s (допустимо: pending, history, all)", filter)
	}
}

func parseIntDefault(s string, def, min, max int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func truncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// pgx 23505 = unique_violation.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": errCode, "message": message},
	})
}
