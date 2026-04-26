package middleware

import (
	"net/http"
	"time"

	"github.com/go-chi/httprate"

	"github.com/HSMM/toolkit/internal/auth"
)

// RateLimitGlobal limits all requests per IP. Used as outer protection.
func RateLimitGlobal(requests int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.LimitByIP(requests, window)
}

// RateLimitByUser limits per authenticated user. Use AFTER RequireAuth.
// Falls back to per-IP if subject is missing (e.g. on the OAuth callback).
func RateLimitByUser(requests int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(
		requests, window,
		httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			if s := auth.FromContext(r.Context()); s != nil {
				return "u:" + s.UserID.String(), nil
			}
			return httprate.KeyByIP(r)
		}),
	)
}
