// Package softphone contains browser softphone APIs.
package softphone

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handlers struct {
	db *pgxpool.Pool
}

func NewHandlers(db *pgxpool.Pool) *Handlers {
	return &Handlers{db: db}
}

func (h *Handlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/", h.create)
	r.Delete("/", h.clear)
	r.Delete("/{id}", h.deleteOne)
	return r
}

type callItem struct {
	ID          uuid.UUID `json:"id"`
	Direction   string    `json:"direction"`
	Number      string    `json:"number"`
	Timestamp   time.Time `json:"timestamp"`
	DurationSec *int      `json:"duration_sec,omitempty"`
	Status      string    `json:"status"`
	Reason      string    `json:"reason,omitempty"`
}

type createCallRequest struct {
	SessionID   string `json:"session_id"`
	Direction   string `json:"direction"`
	Number      string `json:"number"`
	Timestamp   string `json:"timestamp"`
	DurationSec *int   `json:"duration_sec"`
	Status      string `json:"status"`
	Reason      string `json:"reason"`
}

type phoneConfig struct {
	Extensions []phoneExtension `json:"extensions"`
}

type phoneExtension struct {
	Ext        string  `json:"ext"`
	AssignedTo *string `json:"assigned_to,omitempty"`
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	ext, ok, err := h.currentExtension(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_phone_failed", err.Error())
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"items": []callItem{}})
		return
	}

	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	rows, err := h.db.Query(r.Context(), `
		SELECT id, direction, peer_number, started_at, duration_sec, status, COALESCE(reason, '')
		FROM softphone_call_log
		WHERE user_id=$1 AND extension=$2
		ORDER BY started_at DESC
		LIMIT $3
	`, subj.UserID, ext, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	defer rows.Close()

	items := make([]callItem, 0, limit)
	for rows.Next() {
		var item callItem
		if err := rows.Scan(&item.ID, &item.Direction, &item.Number, &item.Timestamp, &item.DurationSec, &item.Status, &item.Reason); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan_failed", err.Error())
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	ext, ok, err := h.currentExtension(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_phone_failed", err.Error())
		return
	}
	if !ok {
		writeErr(w, http.StatusConflict, "extension_not_assigned", "за пользователем не закреплён extension")
		return
	}

	var in createCallRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	in.Direction = strings.TrimSpace(in.Direction)
	in.Number = strings.TrimSpace(in.Number)
	in.Status = strings.TrimSpace(in.Status)
	if in.Number == "" {
		writeErr(w, http.StatusBadRequest, "bad_number", "номер обязателен")
		return
	}
	if !oneOf(in.Direction, "incoming", "outgoing", "missed") {
		writeErr(w, http.StatusBadRequest, "bad_direction", "direction должен быть incoming, outgoing или missed")
		return
	}
	if !oneOf(in.Status, "answered", "missed", "failed", "cancelled", "ended") {
		writeErr(w, http.StatusBadRequest, "bad_status", "status недопустим")
		return
	}
	startedAt := time.Now()
	if in.Timestamp != "" {
		parsed, err := time.Parse(time.RFC3339, in.Timestamp)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_timestamp", err.Error())
			return
		}
		startedAt = parsed
	}

	var item callItem
	err = h.db.QueryRow(r.Context(), `
		INSERT INTO softphone_call_log
			(user_id, extension, session_id, direction, peer_number, started_at, duration_sec, status, reason)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, NULLIF($9, ''))
		ON CONFLICT (user_id, extension, session_id)
			WHERE session_id IS NOT NULL AND session_id <> ''
		DO UPDATE SET
			direction=EXCLUDED.direction,
			peer_number=EXCLUDED.peer_number,
			started_at=EXCLUDED.started_at,
			duration_sec=EXCLUDED.duration_sec,
			status=EXCLUDED.status,
			reason=EXCLUDED.reason
		RETURNING id, direction, peer_number, started_at, duration_sec, status, COALESCE(reason, '')
	`, subj.UserID, ext, in.SessionID, in.Direction, in.Number, startedAt, in.DurationSec, in.Status, in.Reason).
		Scan(&item.ID, &item.Direction, &item.Number, &item.Timestamp, &item.DurationSec, &item.Status, &item.Reason)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, item)
}

func (h *Handlers) deleteOne(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	ext, ok, err := h.currentExtension(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_phone_failed", err.Error())
		return
	}
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", err.Error())
		return
	}
	_, err = h.db.Exec(r.Context(), `
		DELETE FROM softphone_call_log WHERE id=$1 AND user_id=$2 AND extension=$3
	`, id, subj.UserID, ext)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) clear(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	ext, ok, err := h.currentExtension(r, subj.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_phone_failed", err.Error())
		return
	}
	if ok {
		if _, err := h.db.Exec(r.Context(), `
			DELETE FROM softphone_call_log WHERE user_id=$1 AND extension=$2
		`, subj.UserID, ext); err != nil {
			writeErr(w, http.StatusInternalServerError, "clear_failed", err.Error())
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) currentExtension(r *http.Request, userID uuid.UUID) (string, bool, error) {
	var raw []byte
	err := h.db.QueryRow(r.Context(), `SELECT value FROM system_setting WHERE key='phone_config'`).Scan(&raw)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}

	var cfg phoneConfig
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return "", false, err
		}
	}

	uid := userID.String()
	for _, ext := range cfg.Extensions {
		if ext.AssignedTo != nil && *ext.AssignedTo == uid {
			return ext.Ext, true, nil
		}
	}
	return "", false, nil
}

func oneOf(v string, options ...string) bool {
	for _, option := range options {
		if v == option {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{"error": map[string]any{"code": errCode, "message": message}})
}
