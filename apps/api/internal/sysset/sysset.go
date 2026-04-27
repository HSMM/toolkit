// Package sysset — глобальные системные настройки (KV в Postgres).
// Используется для:
//   • module_access — какие модули видят non-admin пользователи. Админам
//     возвращаем правду, но фронт админам всегда показывает все модули
//     независимо от ответа (роль проверяется на стороне UI).
package sysset

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
)

// ModuleAccess — флаги показа модулей в навигации (для non-admin).
type ModuleAccess struct {
	VCS           bool `json:"vcs"`
	Transcription bool `json:"transcription"`
	Messengers    bool `json:"messengers"`
	Contacts      bool `json:"contacts"`
	Helpdesk      bool `json:"helpdesk"`
}

func defaults() ModuleAccess {
	return ModuleAccess{VCS: true, Transcription: true, Messengers: true, Contacts: true, Helpdesk: true}
}

// SMTPConfig — параметры подключения к корпоративному SMTP. Используется
// почтовыми уведомлениями (приглашения на встречи, GDPR-отчёты, алерты).
// Реальная отправка пока не реализована — тест-кнопка возвращает 501.
type SMTPConfig struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Encryption string `json:"encryption"` // ssl | starttls | none
	User       string `json:"user"`
	Password   string `json:"password"`    // только при сохранении; не возвращается в GET
	FromName   string `json:"from_name"`
	FromEmail  string `json:"from_email"`
}

// SMTPConfigPublic — то что отдаём клиенту (без пароля).
type SMTPConfigPublic struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Encryption string `json:"encryption"`
	User       string `json:"user"`
	HasPassword bool  `json:"has_password"` // флаг: пароль сохранён
	FromName   string `json:"from_name"`
	FromEmail  string `json:"from_email"`
}

func smtpDefaults() SMTPConfig {
	return SMTPConfig{Port: 587, Encryption: "starttls"}
}

type Handlers struct{ db *pgxpool.Pool }

func NewHandlers(db *pgxpool.Pool) *Handlers { return &Handlers{db: db} }

// ReadRoutes (auth-required) — фронт читает чтобы скрыть выключенные модули.
func (h *Handlers) ReadRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/modules", h.getModules)
	return r
}

// WriteRoutes (admin only) — изменение флагов и админских настроек.
func (h *Handlers) WriteRoutes() http.Handler {
	r := chi.NewRouter()
	r.Put("/modules", h.putModules)
	r.Get("/smtp", h.getSMTP)
	r.Put("/smtp", h.putSMTP)
	r.Post("/smtp/test", h.testSMTP)
	return r
}

func (h *Handlers) getModules(w http.ResponseWriter, r *http.Request) {
	v, err := h.loadModules(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (h *Handlers) putModules(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	var in ModuleAccess
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	body, _ := json.Marshal(in)
	const q = `
		INSERT INTO system_setting (key, value, updated_by, updated_at)
		VALUES ('module_access', $1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
	`
	if _, err := h.db.Exec(r.Context(), q, body, subj.UserID); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, in)
}

func (h *Handlers) loadModules(ctx context.Context) (ModuleAccess, error) {
	v := defaults()
	var raw []byte
	err := h.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='module_access'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		// повреждённая запись — отдаём дефолты, не валим UI
		return defaults(), nil
	}
	return v, nil
}

func (h *Handlers) getSMTP(w http.ResponseWriter, r *http.Request) {
	c, err := h.loadSMTP(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, SMTPConfigPublic{
		Host: c.Host, Port: c.Port, Encryption: c.Encryption,
		User: c.User, HasPassword: c.Password != "",
		FromName: c.FromName, FromEmail: c.FromEmail,
	})
}

func (h *Handlers) putSMTP(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	var in SMTPConfig
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	// Если password пуст — сохраняем существующий (UI не пересылает пароль).
	if in.Password == "" {
		cur, _ := h.loadSMTP(r.Context())
		in.Password = cur.Password
	}
	if in.Port == 0 {
		in.Port = 587
	}
	body, _ := json.Marshal(in)
	const q = `
		INSERT INTO system_setting (key, value, updated_by, updated_at)
		VALUES ('smtp_config', $1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
	`
	if _, err := h.db.Exec(r.Context(), q, body, subj.UserID); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, SMTPConfigPublic{
		Host: in.Host, Port: in.Port, Encryption: in.Encryption,
		User: in.User, HasPassword: in.Password != "",
		FromName: in.FromName, FromEmail: in.FromEmail,
	})
}

// testSMTP — заглушка. Реальная отправка появится с E8.x (email-уведомления).
func (h *Handlers) testSMTP(w http.ResponseWriter, _ *http.Request) {
	writeErr(w, http.StatusNotImplemented, "not_implemented",
		"тест-отправка появится с email-уведомлениями (E8.x). Сейчас настройки только сохраняются")
}

func (h *Handlers) loadSMTP(ctx context.Context) (SMTPConfig, error) {
	v := smtpDefaults()
	var raw []byte
	err := h.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='smtp_config'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	_ = json.Unmarshal(raw, &v)
	return v, nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, c, m string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": c, "message": m}})
}
