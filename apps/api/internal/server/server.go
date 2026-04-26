// Package server runs the HTTP/WS API.
//
// Layout:
//   - /healthz, /readyz, /version    — health (no auth)
//   - /oauth/*                       — Bitrix24 OAuth flow (no auth, see E1)
//   - /api/v1/*                      — JSON REST API (RequireAuth)
//   - /api/v1/ws                     — WebSocket events (RequireAuth)
//   - /admin/*                       — administrative endpoints (RequireAuth + RequireRole(admin))
//
// All concrete handlers live in their domain packages and are wired here as
// they land (E1.x users/auth, E2.x sync, E3.x base, E5/E6/E7 modules, E8 admin).
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/config"
	"github.com/HSMM/toolkit/internal/db"
	"github.com/HSMM/toolkit/internal/server/middleware"
	"github.com/HSMM/toolkit/internal/ws"
)

// Run starts the API server. Returns when ctx is cancelled (graceful shutdown).
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	jwtIssuer := auth.NewJWTIssuer(cfg.JWTSecret)
	subjectLoader := auth.NewSubjectLoader(pool)
	hub := ws.NewHub(logger)

	r := chi.NewRouter()

	// --- Outer middleware (everything) ---
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(middleware.RequestLogger(logger))
	r.Use(middleware.CORS(cfg.AllowedCORSOrigins))
	r.Use(middleware.RateLimitGlobal(cfg.RateLimitGlobalPerMin, time.Minute))

	// --- Public health + version ---
	r.Get("/healthz", handleHealth(pool))
	r.Get("/readyz", handleHealth(pool))
	r.Get("/version", handleVersion())

	// --- OAuth flow (E1.2) ---
	// Endpoints registered here as the auth handlers package lands. For now,
	// stub so the route group exists.
	r.Route("/oauth", func(r chi.Router) {
		r.Get("/login", stubHandler("E1.2: bitrix24 oauth login redirect"))
		r.Get("/callback", stubHandler("E1.2: bitrix24 oauth code exchange"))
		r.Post("/install", stubHandler("E1.2: bitrix24 local app installation handler"))
		r.Post("/logout", stubHandler("E1.5: logout"))
	})

	// --- Authenticated API ---
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(middleware.RequireAuth(jwtIssuer, subjectLoader, logger))
		r.Use(middleware.RateLimitByUser(cfg.RateLimitUserPerMin, time.Minute))

		r.Get("/me", handleMe())

		// WebSocket events (E3.3).
		r.Mount("/ws", ws.NewHandler(hub, cfg.AllowedCORSOrigins))

		// Domain modules — added as their handler packages land.
		// r.Mount("/calls", calls.Routes(...))
		// r.Mount("/meetings", meetings.Routes(...))
		// r.Mount("/transcripts", transcripts.Routes(...))
		// r.Mount("/contacts", contacts.Routes(...))
	})

	// --- Admin-only endpoints (E8) ---
	r.Route("/admin", func(r chi.Router) {
		r.Use(middleware.RequireAuth(jwtIssuer, subjectLoader, logger))
		r.Use(middleware.RequireRole(auth.RoleAdmin))
		r.Use(middleware.RateLimitByUser(cfg.RateLimitUserPerMin, time.Minute))

		r.Get("/queue/stats", stubHandler("E3.4 admin: queue stats — added later"))
		// r.Mount("/users", admin.UsersRoutes(...))
		// r.Mount("/policies", admin.PolicyRoutes(...))
		// r.Mount("/gdpr", admin.GDPRRoutes(...))
		// r.Mount("/audit", admin.AuditRoutes(...))
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("api listening", "addr", srv.Addr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		logger.Info("api shutting down")
	case err := <-errCh:
		if err != nil {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	users, sockets := hub.CountConnected()
	logger.Info("api stopped", "ws_users_at_shutdown", users, "ws_sockets_at_shutdown", sockets)
	return nil
}

func handleHealth(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"unhealthy","db":"down"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}
}

func handleVersion() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"0.0.1","mode":"api"}`))
	}
}

// handleMe returns the calling subject's basic profile. First "real" handler
// of /api/v1 — proves the auth middleware chain works end-to-end.
func handleMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := auth.MustSubject(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w,
			`{"user_id":"%s","email":"%s","role":"%s","supervises":%d,"session_id":"%s"}`,
			s.UserID, s.Email, s.Role, len(s.Supervises), s.SessionID)
	}
}

// stubHandler returns 501 Not Implemented for routes that are reserved but
// not yet wired (handlers come in later epics).
func stubHandler(label string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = fmt.Fprintf(w, `{"error":{"code":"not_implemented","message":%q}}`, label)
	}
}
