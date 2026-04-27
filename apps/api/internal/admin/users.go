// Package admin — admin-only HTTP endpoints.
// Сейчас реализован только список пользователей для «Настройки системы →
// Пользователи». Управление ролями/блокировкой добавится позже.
package admin

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type UsersHandlers struct{ db *pgxpool.Pool }

func NewUsersHandlers(db *pgxpool.Pool) *UsersHandlers { return &UsersHandlers{db: db} }

// Routes монтируются под /admin/users.
func (h *UsersHandlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	return r
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
