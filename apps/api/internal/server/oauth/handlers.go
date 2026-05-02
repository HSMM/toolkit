package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/bitrix"
	"github.com/HSMM/toolkit/internal/config"
	"github.com/HSMM/toolkit/internal/mailer"
)

const refreshCookieName = "toolkit_refresh"
const passwordResetTTL = time.Hour

type Handlers struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	logger   *slog.Logger
	state    *auth.OAuthStateMinter
	jwt      *auth.JWTIssuer
	sessions *auth.SessionStore
	bitrix   *bitrix.Client
	mailer   *mailer.Client
}

func New(cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger, jwt *auth.JWTIssuer) *Handlers {
	return &Handlers{
		cfg:      cfg,
		pool:     pool,
		logger:   logger,
		state:    auth.NewOAuthStateMinter(cfg.JWTSecret),
		jwt:      jwt,
		sessions: auth.NewSessionStore(pool),
		mailer:   mailer.New(pool),
		bitrix: &bitrix.Client{
			PortalURL:    cfg.BitrixPortalURL,
			ClientID:     cfg.BitrixClientID,
			ClientSecret: cfg.BitrixClientSecret,
		},
	}
}

func (h *Handlers) PasswordResetRequest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	email := strings.TrimSpace(strings.ToLower(in.Email))
	if email == "" {
		writeJSONError(w, http.StatusBadRequest, "email_required", "Email is required")
		return
	}

	// Не раскрываем наличие аккаунта и включенного локального пароля.
	ok := map[string]string{"status": "ok"}

	var (
		userID   uuid.UUID
		fullName string
	)
	const q = `
		SELECT id, COALESCE(NULLIF(full_name, ''), email)
		FROM "user"
		WHERE LOWER(email)=LOWER($1)
		  AND status='active'
		  AND deleted_in_bx24=FALSE
		  AND COALESCE(password_hash, '') <> ''
	`
	if err := h.pool.QueryRow(r.Context(), q, email).Scan(&userID, &fullName); err != nil {
		if err != pgx.ErrNoRows {
			h.logger.Error("password reset user lookup failed", "err", err, "email", email)
		}
		writeJSON(w, http.StatusOK, ok)
		return
	}

	token, err := randomHexToken(32)
	if err != nil {
		h.logger.Error("password reset token generation failed", "err", err)
		writeJSONError(w, http.StatusInternalServerError, "reset_failed", "Cannot create password reset link")
		return
	}
	tokenHash := hashPlainToken(token)
	expiresAt := time.Now().Add(passwordResetTTL)
	if _, err := h.pool.Exec(r.Context(), `
		UPDATE password_reset_token
		   SET used_at = NOW()
		 WHERE user_id = $1 AND used_at IS NULL
	`, userID); err != nil {
		h.logger.Warn("password reset old token invalidate failed", "err", err, "user_id", userID)
	}
	if _, err := h.pool.Exec(r.Context(), `
		INSERT INTO password_reset_token (user_id, token_hash, expires_at, ip, user_agent)
		VALUES ($1, $2, $3, NULLIF($4, '')::inet, NULLIF($5, ''))
	`, userID, tokenHash, expiresAt, clientIP(r), r.UserAgent()); err != nil {
		h.logger.Error("password reset token save failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "reset_failed", "Cannot create password reset link")
		return
	}

	resetURL := h.passwordResetURL(token)
	if err := h.mailer.Send(r.Context(), mailer.Message{
		To:       []string{email},
		Subject:  "Восстановление пароля Toolkit",
		HTMLBody: buildPasswordResetHTML(fullName, resetURL),
	}); err != nil {
		h.logger.Error("password reset email failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "email_send_failed", "Не удалось отправить письмо восстановления")
		return
	}

	writeJSON(w, http.StatusOK, ok)
}

func (h *Handlers) PasswordResetConfirm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	token := strings.TrimSpace(in.Token)
	password := strings.TrimSpace(in.Password)
	if token == "" || password == "" {
		writeJSONError(w, http.StatusBadRequest, "reset_payload_required", "Token and password are required")
		return
	}
	if len(password) < 8 {
		writeJSONError(w, http.StatusBadRequest, "weak_password", "Password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "hash_failed", "Cannot update password")
		return
	}

	var userID uuid.UUID
	err = h.pool.QueryRow(r.Context(), `
		UPDATE password_reset_token prt
		   SET used_at = NOW()
		 WHERE prt.token_hash = $1
		   AND prt.used_at IS NULL
		   AND prt.expires_at > NOW()
		RETURNING prt.user_id
	`, hashPlainToken(token)).Scan(&userID)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSONError(w, http.StatusBadRequest, "invalid_reset_token", "Reset link is invalid or expired")
			return
		}
		h.logger.Error("password reset token consume failed", "err", err)
		writeJSONError(w, http.StatusInternalServerError, "reset_failed", "Cannot update password")
		return
	}

	if _, err := h.pool.Exec(r.Context(), `
		UPDATE "user"
		   SET password_hash=$2, password_changed_at=NOW()
		 WHERE id=$1 AND status='active' AND deleted_in_bx24=FALSE
	`, userID, string(hash)); err != nil {
		h.logger.Error("password reset user update failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "reset_failed", "Cannot update password")
		return
	}
	if err := h.sessions.RevokeAllForUser(r.Context(), userID); err != nil {
		h.logger.Warn("password reset revoke sessions failed", "err", err, "user_id", userID)
	}
	_, _ = h.pool.Exec(r.Context(), `
		INSERT INTO audit_log (actor_id, action, target_kind, target_id, details)
		VALUES (NULL, 'user.password.reset', 'user', $1, '{}'::jsonb)
	`, userID.String())

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	if h.cfg.BitrixPortalURL == "" || h.cfg.BitrixClientID == "" || h.cfg.BitrixClientSecret == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "bitrix_oauth_not_configured", "Bitrix24 OAuth is not configured")
		return
	}
	returnTo := safeReturnPath(r.URL.Query().Get("return_to"))
	state, err := h.state.Mint(returnTo)
	if err != nil {
		h.logger.Error("oauth state mint failed", "err", err)
		writeJSONError(w, http.StatusInternalServerError, "state_error", "Cannot start OAuth flow")
		return
	}
	authURL, err := h.bitrix.AuthorizeURL(h.callbackURL(), state)
	if err != nil {
		h.logger.Error("bitrix authorize url failed", "err", err)
		writeJSONError(w, http.StatusInternalServerError, "bitrix_url_error", "Cannot build Bitrix24 OAuth URL")
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (h *Handlers) PasswordLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	login := strings.TrimSpace(strings.ToLower(in.Login))
	if login == "" || in.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "credentials_required", "Login and password are required")
		return
	}

	var (
		userID       uuid.UUID
		email        string
		status       string
		deletedInBx  bool
		passwordHash string
	)
	const q = `
		SELECT id, email, status, deleted_in_bx24, COALESCE(password_hash, '')
		FROM "user"
		WHERE LOWER(email)=LOWER($1)
	`
	err := h.pool.QueryRow(r.Context(), q, login).Scan(&userID, &email, &status, &deletedInBx, &passwordHash)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSONError(w, http.StatusUnauthorized, "bad_credentials", "Invalid login or password")
			return
		}
		h.logger.Error("password login user lookup failed", "err", err, "login", login)
		writeJSONError(w, http.StatusInternalServerError, "login_failed", "Cannot log in")
		return
	}
	if status == "blocked" {
		writeJSONError(w, http.StatusForbidden, "user_blocked", "User is blocked")
		return
	}
	if status == "deactivated_in_bitrix" || deletedInBx {
		writeJSONError(w, http.StatusForbidden, "user_deactivated", "User is deactivated")
		return
	}
	if passwordHash == "" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(in.Password)) != nil {
		writeJSONError(w, http.StatusUnauthorized, "bad_credentials", "Invalid login or password")
		return
	}

	refreshToken, sessionID, err := h.sessions.Create(r.Context(), userID, clientIP(r), r.UserAgent(), "")
	if err != nil {
		h.logger.Error("password session create failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "session_create_failed", "Cannot create session")
		return
	}
	if _, err := h.pool.Exec(r.Context(), `UPDATE "user" SET last_login_at=NOW() WHERE id=$1`, userID); err != nil {
		h.logger.Warn("password login last_login update failed", "err", err, "user_id", userID)
	}

	claims := &auth.AccessClaims{UserID: userID, SessionID: sessionID, Email: email}
	subj, err := auth.NewSubjectLoader(h.pool).LoadFromClaims(r.Context(), claims)
	if err != nil {
		_ = h.sessions.Revoke(r.Context(), sessionID)
		writeJSONError(w, http.StatusUnauthorized, "subject_load_failed", "Cannot log in")
		return
	}
	access, err := h.jwt.Issue(subj.UserID, subj.SessionID, subj.Email, subj.Role)
	if err != nil {
		_ = h.sessions.Revoke(r.Context(), sessionID)
		writeJSONError(w, http.StatusInternalServerError, "jwt_issue_failed", "Cannot issue access token")
		return
	}
	http.SetCookie(w, h.refreshCookie(refreshToken, int(auth.RefreshTokenInactivityTTL.Seconds())))
	writeJSON(w, http.StatusOK, map[string]string{"access_token": access})
}

func (h *Handlers) Callback(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		writeJSONError(w, http.StatusBadRequest, "bad_oauth_callback", "Missing OAuth code or state")
		return
	}
	returnTo, err := h.state.Verify(state)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_oauth_state", "Invalid or expired OAuth state")
		return
	}

	token, err := h.bitrix.ExchangeCode(r.Context(), code, h.callbackURL(), r.URL.Query().Get("server_domain"))
	if err != nil {
		h.logger.Error("bitrix code exchange failed", "err", err)
		writeJSONError(w, http.StatusBadGateway, "bitrix_exchange_failed", "Bitrix24 code exchange failed")
		return
	}
	bxUser, err := h.bitrix.CurrentUser(r.Context(), token.AccessToken)
	if err != nil {
		h.logger.Error("bitrix user.current failed", "err", err)
		writeJSONError(w, http.StatusBadGateway, "bitrix_user_failed", "Cannot load Bitrix24 user")
		return
	}

	departments, err := h.bitrix.ListDepartments(r.Context(), token.AccessToken)
	if err != nil {
		h.logger.Warn("bitrix departments load failed", "err", err)
		departments = nil
	}

	userID, email, err := h.upsertUser(r.Context(), bxUser, departments)
	if err != nil {
		h.logger.Error("toolkit user upsert failed", "err", err, "bitrix_id", bxUser.ID)
		writeJSONError(w, http.StatusInternalServerError, "user_upsert_failed", "Cannot create Toolkit user")
		return
	}
	if err := h.bootstrapAdminIfNeeded(r.Context(), userID, email); err != nil {
		h.logger.Error("bootstrap admin failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "bootstrap_admin_failed", "Cannot bootstrap admin")
		return
	}

	refreshToken, _, err := h.sessions.Create(r.Context(), userID, clientIP(r), r.UserAgent(), encodeToken(token.RefreshToken))
	if err != nil {
		h.logger.Error("session create failed", "err", err, "user_id", userID)
		writeJSONError(w, http.StatusInternalServerError, "session_create_failed", "Cannot create session")
		return
	}
	http.SetCookie(w, h.refreshCookie(refreshToken, int(auth.RefreshTokenInactivityTTL.Seconds())))
	http.Redirect(w, r, returnTo, http.StatusFound)
}

func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(refreshCookieName)
	if err != nil || cookie.Value == "" {
		writeJSONError(w, http.StatusUnauthorized, "missing_refresh", "Missing refresh session")
		return
	}
	rec, err := h.sessions.Validate(r.Context(), cookie.Value)
	if err != nil {
		clearRefreshCookie(w, h.secureCookie())
		writeJSONError(w, http.StatusUnauthorized, "invalid_refresh", "Invalid refresh session")
		return
	}
	if err := h.sessions.Touch(r.Context(), rec.ID); err != nil {
		h.logger.Warn("session touch failed", "err", err, "session_id", rec.ID)
	}

	claims := &auth.AccessClaims{UserID: rec.UserID, SessionID: rec.ID}
	subj, err := auth.NewSubjectLoader(h.pool).LoadFromClaims(r.Context(), claims)
	if err != nil {
		clearRefreshCookie(w, h.secureCookie())
		writeJSONError(w, http.StatusUnauthorized, "subject_load_failed", "Cannot refresh session")
		return
	}
	access, err := h.jwt.Issue(subj.UserID, subj.SessionID, subj.Email, subj.Role)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "jwt_issue_failed", "Cannot issue access token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"access_token": access})
}

func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(refreshCookieName); err == nil && cookie.Value != "" {
		if rec, err := h.sessions.Validate(r.Context(), cookie.Value); err == nil {
			_ = h.sessions.Revoke(r.Context(), rec.ID)
		}
	}
	clearRefreshCookie(w, h.secureCookie())
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) Install(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) upsertUser(ctx context.Context, u *bitrix.User, departments map[string]string) (uuid.UUID, string, error) {
	email := strings.TrimSpace(strings.ToLower(u.Email))
	if email == "" {
		return uuid.Nil, "", fmt.Errorf("bitrix user %s has empty email", u.ID)
	}
	fullName := strings.TrimSpace(u.FullName())
	if fullName == "" {
		fullName = email
	}
	const q = `
		INSERT INTO "user" (bitrix_id, email, full_name, phone, department, position, avatar_url, status, deleted_in_bx24, last_login_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), 'active', FALSE, NOW())
		ON CONFLICT (bitrix_id) DO UPDATE SET
			email = EXCLUDED.email,
			full_name = EXCLUDED.full_name,
			phone = EXCLUDED.phone,
			department = EXCLUDED.department,
			position = EXCLUDED.position,
			avatar_url = EXCLUDED.avatar_url,
			status = CASE WHEN "user".status = 'deactivated_in_bitrix' THEN 'active' ELSE "user".status END,
			deleted_in_bx24 = FALSE,
			last_login_at = NOW()
		RETURNING id, email
	`
	var id uuid.UUID
	if err := h.pool.QueryRow(ctx, q, u.ID, email, fullName, u.Phone(), u.DepartmentName(departments), u.WorkPosition, u.PersonalPhoto).Scan(&id, &email); err != nil {
		return uuid.Nil, "", err
	}
	return id, email, nil
}

func (h *Handlers) bootstrapAdminIfNeeded(ctx context.Context, userID uuid.UUID, email string) error {
	if len(h.cfg.BootstrapAdmins) > 0 {
		for _, adminEmail := range h.cfg.BootstrapAdmins {
			if strings.EqualFold(strings.TrimSpace(adminEmail), email) {
				return auth.PromoteAdmin(ctx, h.pool, userID, uuid.Nil)
			}
		}
		return nil
	}

	var hasAdmin bool
	const q = `
		SELECT EXISTS (
			SELECT 1 FROM role_assignment ra
			JOIN "user" u ON u.id = ra.user_id
			WHERE ra.role = 'admin' AND u.status = 'active'
		)
	`
	if err := h.pool.QueryRow(ctx, q).Scan(&hasAdmin); err != nil && err != pgx.ErrNoRows {
		return err
	}
	if !hasAdmin {
		return auth.PromoteAdmin(ctx, h.pool, userID, uuid.Nil)
	}
	return nil
}

func (h *Handlers) callbackURL() string {
	base := strings.TrimRight(h.cfg.BaseURL, "/")
	if base == "" {
		base = "http://localhost:8080"
	}
	return base + "/oauth/callback"
}

func (h *Handlers) passwordResetURL(token string) string {
	base := strings.TrimRight(h.cfg.BaseURL, "/")
	if base == "" {
		base = "http://localhost:8080"
	}
	return base + "/reset-password?token=" + url.QueryEscape(token)
}

func (h *Handlers) refreshCookie(token string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Path:     "/oauth",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	}
}

func clearRefreshCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/oauth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handlers) secureCookie() bool {
	u, err := url.Parse(h.cfg.BaseURL)
	return err == nil && u.Scheme == "https"
}

func safeReturnPath(s string) string {
	if s == "" || !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") {
		return "/"
	}
	return s
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if ip := strings.TrimSpace(strings.Split(fwd, ",")[0]); net.ParseIP(ip) != nil {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}
	return host
}

func encodeToken(token string) string {
	if token == "" {
		return ""
	}
	return base64.StdEncoding.EncodeToString([]byte(token))
}

func randomHexToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func hashPlainToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func buildPasswordResetHTML(name, resetURL string) string {
	n := html.EscapeString(strings.TrimSpace(name))
	if n == "" {
		n = "коллега"
	}
	u := html.EscapeString(resetURL)
	return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">` +
		`<div style="display:none;max-height:0;overflow:hidden;color:transparent">Ссылка для восстановления пароля Toolkit действует 1 час.</div>` +
		`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:28px 12px"><tr><td align="center">` +
		`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5eaf2;border-radius:18px;overflow:hidden">` +
		`<tr><td style="background:#0f766e;padding:28px 30px;color:#ffffff">` +
		`<div style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;opacity:.82;font-weight:700">Toolkit</div>` +
		`<h1 style="margin:10px 0 0;font-size:25px;line-height:1.2;font-weight:750">Восстановление пароля</h1>` +
		`</td></tr>` +
		`<tr><td style="padding:30px">` +
		`<p style="margin:0 0 14px;font-size:16px;line-height:1.55">Здравствуйте, ` + n + `.</p>` +
		`<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#4b5563">Мы получили запрос на смену пароля для входа в Toolkit. Нажмите кнопку ниже и задайте новый пароль. Ссылка одноразовая и действует 1 час.</p>` +
		`<p style="margin:0 0 24px"><a href="` + u + `" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:10px;font-size:15px;font-weight:700">Задать новый пароль</a></p>` +
		`<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:0 0 18px">` +
		`<div style="font-size:12px;color:#64748b;margin-bottom:6px">Если кнопка не открывается, скопируйте ссылку:</div>` +
		`<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#0f172a;word-break:break-all">` + u + `</div>` +
		`</div>` +
		`<p style="margin:0;font-size:13px;line-height:1.55;color:#64748b">Если вы не запрашивали восстановление, просто проигнорируйте это письмо. Старый пароль останется действующим.</p>` +
		`</td></tr>` +
		`<tr><td style="padding:18px 30px;background:#f8fafc;color:#94a3b8;font-size:12px">Автоматическое сообщение от Toolkit · BIXIOM Tech</td></tr>` +
		`</table></td></tr></table></body></html>`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
