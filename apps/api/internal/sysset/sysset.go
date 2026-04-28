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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/ws"
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
// Реальная отправка пока не реализована — тест-эндпоинт возвращает 501.
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

// PhoneExtension — внутренний номер FreePBX, привязанный к Toolkit.
// AssignedTo (UUID user'а) опциональный — если NULL, номер «свободен».
type PhoneExtension struct {
	Ext        string  `json:"ext"`
	Password   string  `json:"password,omitempty"` // только при PUT; в GET вместо него HasPassword
	AssignedTo *string `json:"assigned_to,omitempty"`
}
type PhoneExtensionPublic struct {
	Ext         string  `json:"ext"`
	HasPassword bool    `json:"has_password"`
	AssignedTo  *string `json:"assigned_to,omitempty"`
}

// PhoneConfig — параметры FreePBX и список extension'ов.
type PhoneConfig struct {
	WssURL     string           `json:"wss_url"`
	Extensions []PhoneExtension `json:"extensions"`
}
type PhoneConfigPublic struct {
	WssURL     string                 `json:"wss_url"`
	Extensions []PhoneExtensionPublic `json:"extensions"`
}

// EventPhoneExtensionUnassigned — сервер шлёт пользователю, у которого админ
// только что отвязал extension (или удалил extension вместе с привязкой). На
// этот event фронт должен остановить JsSIP, очистить sessionStorage-creds и
// перерисовать виджет в состояние «не назначен» (CTA «Запросить номер»).
const EventPhoneExtensionUnassigned = "phone_extension_unassigned"

type Handlers struct {
	db  *pgxpool.Pool
	hub *ws.Hub // опционально: если nil, broadcast-события не шлются
}

// NewHandlers — без hub'а: broadcast'ы выключены (для тестов / простых сценариев).
func NewHandlers(db *pgxpool.Pool) *Handlers { return &Handlers{db: db} }

// NewHandlersWithHub — основной конструктор; hub нужен для phone_extension_unassigned.
func NewHandlersWithHub(db *pgxpool.Pool, hub *ws.Hub) *Handlers {
	return &Handlers{db: db, hub: hub}
}

// ReadRoutes (auth-required) — фронт читает чтобы скрыть выключенные модули.
func (h *Handlers) ReadRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/modules", h.getModules)
	// Авторизованный пользователь читает СВОИ SIP-креды (для софтфона). Это
	// единственный extension, привязанный к нему через assigned_to. Полный
	// список с паролями всех номеров доступен только админу через WriteRoutes.
	r.Get("/phone/me", h.getMyPhoneCredentials)
	return r
}

// WriteRoutes (admin only) — изменение флагов и админских настроек.
func (h *Handlers) WriteRoutes() http.Handler {
	r := chi.NewRouter()
	r.Put("/modules", h.putModules)
	r.Get("/smtp", h.getSMTP)
	r.Put("/smtp", h.putSMTP)
	r.Post("/smtp/test", h.testSMTP)
	r.Get("/phone", h.getPhone)
	r.Put("/phone", h.putPhone)
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

// testSMTP — заглушка до полноценного email-пайплайна.
func (h *Handlers) testSMTP(w http.ResponseWriter, _ *http.Request) {
	writeErr(w, http.StatusNotImplemented, "not_implemented",
		"тест-отправка появится позже; сейчас настройки только сохраняются")
}

// MyPhoneCredentials — то, что нужно браузерному JsSIP-клиенту для регистрации.
// Возвращается ТОЛЬКО владельцу extension'а (subject.UserID == assigned_to).
type MyPhoneCredentials struct {
	WssURL    string `json:"wss_url"`
	Extension string `json:"extension"`
	Password  string `json:"password"`
}

func (h *Handlers) getMyPhoneCredentials(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	c, err := h.loadPhone(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	uid := subj.UserID.String()
	for _, e := range c.Extensions {
		if e.AssignedTo != nil && *e.AssignedTo == uid {
			writeJSON(w, http.StatusOK, MyPhoneCredentials{
				WssURL: c.WssURL, Extension: e.Ext, Password: e.Password,
			})
			return
		}
	}
	writeErr(w, http.StatusNotFound, "not_assigned", "за пользователем не закреплён extension")
}

func (h *Handlers) getPhone(w http.ResponseWriter, r *http.Request) {
	c, err := h.loadPhone(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	out := PhoneConfigPublic{WssURL: c.WssURL, Extensions: make([]PhoneExtensionPublic, 0, len(c.Extensions))}
	for _, e := range c.Extensions {
		out.Extensions = append(out.Extensions, PhoneExtensionPublic{
			Ext: e.Ext, HasPassword: e.Password != "", AssignedTo: e.AssignedTo,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handlers) putPhone(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	var in PhoneConfig
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	// Сохраняем существующие пароли для тех extension'ов, где клиент
	// прислал пустую строку (значит UI не редактировал поле).
	cur, _ := h.loadPhone(r.Context())
	curMap := map[string]string{}
	for _, e := range cur.Extensions {
		curMap[e.Ext] = e.Password
	}
	for i, e := range in.Extensions {
		if e.Password == "" {
			in.Extensions[i].Password = curMap[e.Ext]
		}
	}
	body, _ := json.Marshal(in)
	const q = `
		INSERT INTO system_setting (key, value, updated_by, updated_at)
		VALUES ('phone_config', $1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
	`
	if _, err := h.db.Exec(r.Context(), q, body, subj.UserID); err != nil {
		writeErr(w, http.StatusInternalServerError, "save_failed", err.Error())
		return
	}

	// Diff — кому стало «не назначено». Считаем «отвязали», если user_id
	// был в cur.Extensions с этим ext, а в in.Extensions либо запись с этим
	// ext удалили целиком, либо assigned_to сменили на nil/другого user'а.
	h.publishUnassigned(diffUnassigned(cur, in))

	h.getPhone(w, r) // вернём отдекредентенный публичный вид
}

// diffUnassigned — возвращает map user_id → previous extension для тех, кому
// привязка была снята (а также для extension'ов, удалённых полностью или
// переназначенных другому user'у).
func diffUnassigned(cur, next PhoneConfig) map[uuid.UUID]string {
	curAssign := map[string]string{} // user_id_str → ext
	for _, e := range cur.Extensions {
		if e.AssignedTo != nil && *e.AssignedTo != "" {
			curAssign[*e.AssignedTo] = e.Ext
		}
	}
	nextAssign := map[string]string{}
	for _, e := range next.Extensions {
		if e.AssignedTo != nil && *e.AssignedTo != "" {
			nextAssign[*e.AssignedTo] = e.Ext
		}
	}
	out := map[uuid.UUID]string{}
	for uidStr, prevExt := range curAssign {
		nextExt, stillAssigned := nextAssign[uidStr]
		if !stillAssigned || nextExt != prevExt {
			uid, err := uuid.Parse(uidStr)
			if err != nil {
				continue
			}
			out[uid] = prevExt
		}
	}
	return out
}

func (h *Handlers) publishUnassigned(targets map[uuid.UUID]string) {
	if h.hub == nil || len(targets) == 0 {
		return
	}
	for uid, prevExt := range targets {
		payload, err := json.Marshal(map[string]any{"prev_extension": prevExt})
		if err != nil {
			continue
		}
		h.hub.Publish(uid, ws.Event{Type: EventPhoneExtensionUnassigned, Payload: payload})
	}
}

func (h *Handlers) loadPhone(ctx context.Context) (PhoneConfig, error) {
	v := PhoneConfig{Extensions: []PhoneExtension{}}
	var raw []byte
	err := h.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='phone_config'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	_ = json.Unmarshal(raw, &v)
	if v.Extensions == nil {
		v.Extensions = []PhoneExtension{}
	}
	return v, nil
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
