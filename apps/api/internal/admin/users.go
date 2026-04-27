// Package admin — admin-only HTTP endpoints.
package admin

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/HSMM/toolkit/internal/bitrix"
	"github.com/HSMM/toolkit/internal/usersync"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type UsersHandlers struct {
	db       *pgxpool.Pool
	bxClient *bitrix.Client
}

func NewUsersHandlers(db *pgxpool.Pool) *UsersHandlers { return &UsersHandlers{db: db} }

// SetBitrixSync включает endpoint /sync/bitrix. Sync использует OAuth-токен
// активной admin-сессии (см. usersync.refreshAdminToken).
func (h *UsersHandlers) SetBitrixSync(client *bitrix.Client) {
	h.bxClient = client
}

// Routes монтируются под /admin/users.
func (h *UsersHandlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Put("/{id}/role", h.setRole)         // body: {"role":"admin"|"user"}
	r.Put("/{id}/status", h.setStatus)     // body: {"status":"active"|"blocked"}
	r.Post("/sync/bitrix", h.syncBitrix)   // body: {} → {fetched, added, updated, ...}
	return r
}

func (h *UsersHandlers) syncBitrix(w http.ResponseWriter, r *http.Request) {
	if h.bxClient == nil {
		writeErr(w, http.StatusServiceUnavailable, "sync_not_configured",
			"Bitrix24 OAuth не настроен (BITRIX_PORTAL_URL/CLIENT_ID/CLIENT_SECRET)")
		return
	}
	res, err := usersync.Run(r.Context(), h.db, h.bxClient)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "sync_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type roleReq struct {
	Role string `json:"role"`
}
type statusReq struct {
	Status string `json:"status"`
}

func (h *UsersHandlers) setRole(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid user id")
		return
	}
	var req roleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	switch req.Role {
	case "admin":
		// Берём admin'а из контекста через subject (для granted_by) — но в этом
		// пакете нет импорта auth; берём id из header x-toolkit-user (выставляется
		// нашим RequireAuth middleware) — нет, не выставляется.
		// Простейший вариант: granted_by NULL.
		_, err = h.db.Exec(r.Context(), `
			INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin')
			ON CONFLICT (user_id, role) DO NOTHING
		`, id)
	case "user":
		// Защита от удаления последнего админа.
		var adminCount int
		_ = h.db.QueryRow(r.Context(), `SELECT COUNT(*) FROM role_assignment WHERE role='admin'`).Scan(&adminCount)
		if adminCount <= 1 {
			writeErr(w, http.StatusConflict, "last_admin", "нельзя снять права у последнего администратора")
			return
		}
		_, err = h.db.Exec(r.Context(), `DELETE FROM role_assignment WHERE user_id=$1 AND role='admin'`, id)
	default:
		writeErr(w, http.StatusBadRequest, "bad_role", "role must be admin or user")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UsersHandlers) setStatus(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid user id")
		return
	}
	var req statusReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if req.Status != "active" && req.Status != "blocked" {
		writeErr(w, http.StatusBadRequest, "bad_status", "status must be active or blocked")
		return
	}
	if _, err := h.db.Exec(r.Context(),
		`UPDATE "user" SET status=$2 WHERE id=$1`, id, req.Status); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type userRow struct {
	ID          uuid.UUID  `json:"id"`
	BitrixID    string     `json:"bitrix_id"`
	Email       string     `json:"email"`
	FullName    string     `json:"full_name"`
	Phone       string     `json:"phone,omitempty"`
	Department  string     `json:"department,omitempty"`
	Position    string     `json:"position,omitempty"`
	AvatarURL   string     `json:"avatar_url,omitempty"`
	Extension   string     `json:"extension,omitempty"`
	Status      string     `json:"status"`        // active | blocked
	IsAdmin     bool       `json:"is_admin"`      // есть запись в role_assignment
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

func (h *UsersHandlers) list(w http.ResponseWriter, r *http.Request) {
	const q = `
		SELECT u.id, u.bitrix_id, u.email, u.full_name,
		       COALESCE(u.phone, ''), COALESCE(u.department, ''),
		       COALESCE(u.position, ''), COALESCE(u.avatar_url, ''),
		       COALESCE(u.extension, ''), u.status,
		       EXISTS (SELECT 1 FROM role_assignment ra WHERE ra.user_id = u.id AND ra.role = 'admin') AS is_admin,
		       u.last_login_at, u.created_at
		FROM "user" u
		ORDER BY (u.status = 'active') DESC, u.full_name
	`
	rows, err := h.db.Query(r.Context(), q)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	defer rows.Close()
	out := make([]userRow, 0, 64)
	for rows.Next() {
		var u userRow
		if err := rows.Scan(&u.ID, &u.BitrixID, &u.Email, &u.FullName,
			&u.Phone, &u.Department, &u.Position, &u.AvatarURL,
			&u.Extension, &u.Status, &u.IsAdmin, &u.LastLoginAt, &u.CreatedAt,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan_failed", err.Error())
			return
		}
		out = append(out, u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": errCode, "message": message}})
}
