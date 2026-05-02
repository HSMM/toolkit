package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/bitrix"
	"github.com/HSMM/toolkit/internal/config"
)

const refreshCookieName = "toolkit_refresh"

type Handlers struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	logger   *slog.Logger
	state    *auth.OAuthStateMinter
	jwt      *auth.JWTIssuer
	sessions *auth.SessionStore
	bitrix   *bitrix.Client
}

func New(cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger, jwt *auth.JWTIssuer) *Handlers {
	return &Handlers{
		cfg:      cfg,
		pool:     pool,
		logger:   logger,
		state:    auth.NewOAuthStateMinter(cfg.JWTSecret),
		jwt:      jwt,
		sessions: auth.NewSessionStore(pool),
		bitrix: &bitrix.Client{
			PortalURL:    cfg.BitrixPortalURL,
			ClientID:     cfg.BitrixClientID,
			ClientSecret: cfg.BitrixClientSecret,
		},
	}
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
