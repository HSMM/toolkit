// Package middleware contains HTTP middleware specific to Toolkit
// (auth, audit-context, sensitive-header masking, etc.). Generic chi
// middleware (RequestID, RealIP, Recoverer) is used directly from chi.
package middleware

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/HSMM/toolkit/internal/auth"
)

// RequireAuth verifies the bearer JWT, hydrates the Subject, and attaches it
// to the request context. On failure: 401 (unauthenticated/expired/invalid)
// or 403 (user blocked / deactivated in Bitrix24).
func RequireAuth(jwt *auth.JWTIssuer, loader *auth.SubjectLoader, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := bearerToken(r)
			if tok == "" {
				writeAuthError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			claims, err := jwt.Verify(tok)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrExpiredToken):
					writeAuthError(w, http.StatusUnauthorized, "token expired")
				default:
					writeAuthError(w, http.StatusUnauthorized, "invalid token")
				}
				return
			}
			subj, err := loader.LoadFromClaims(r.Context(), claims)
			if err != nil {
				switch {
				case errors.Is(err, auth.ErrUserBlocked):
					writeAuthError(w, http.StatusForbidden, "user blocked in toolkit")
				case errors.Is(err, auth.ErrUserDeactivated):
					writeAuthError(w, http.StatusForbidden, "user deactivated in bitrix24")
				default:
					logger.Error("subject load failed", "err", err, "user_id", claims.UserID)
					writeAuthError(w, http.StatusInternalServerError, "auth subsystem error")
				}
				return
			}
			next.ServeHTTP(w, r.WithContext(auth.WithSubject(r.Context(), subj)))
		})
	}
}

// RequireRole returns 403 unless the subject has at least one of the given roles.
// Use AFTER RequireAuth in the middleware chain.
func RequireRole(roles ...auth.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			s := auth.FromContext(r.Context())
			if s == nil {
				writeAuthError(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			for _, want := range roles {
				if s.Role == want {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeAuthError(w, http.StatusForbidden, "insufficient role")
		})
	}
}

func bearerToken(r *http.Request) string {
	// 1. Стандартный заголовок — Authorization: Bearer <token>.
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	// 2. WebSocket-handshake — браузер не разрешает кастомные заголовки на WS,
	// поэтому JWT передаётся в Sec-WebSocket-Protocol: «bearer.<token>».
	// Может быть несколько subprotocol'ов через запятую.
	if proto := r.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		const wsPrefix = "bearer."
		for _, p := range strings.Split(proto, ",") {
			p = strings.TrimSpace(p)
			if strings.HasPrefix(p, wsPrefix) {
				return p[len(wsPrefix):]
			}
		}
	}
	return ""
}

func writeAuthError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(`{"error":{"code":"` + http.StatusText(code) + `","message":"` + escapeJSON(msg) + `"}}`))
}

func escapeJSON(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				continue
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}
