// Package server runs the HTTP/WS API.
//
// Layout:
//   - /healthz, /readyz, /version    — health (no auth)
//   - /oauth/*                       — Bitrix24 OAuth flow (no auth)
//   - /api/v1/*                      — JSON REST API (RequireAuth)
//   - /api/v1/ws                     — WebSocket events (RequireAuth)
//   - /admin/*                       — administrative endpoints (RequireAuth + RequireRole(admin))
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/admin"
	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/sysset"
	"github.com/HSMM/toolkit/internal/config"
	"github.com/HSMM/toolkit/internal/db"
	"github.com/HSMM/toolkit/internal/gigaam"
	livekitclient "github.com/HSMM/toolkit/internal/livekit"
	"github.com/HSMM/toolkit/internal/meetings"
	"github.com/HSMM/toolkit/internal/queue"
	"github.com/HSMM/toolkit/internal/server/middleware"
	oauthhandlers "github.com/HSMM/toolkit/internal/server/oauth"
	"github.com/HSMM/toolkit/internal/storage"
	"github.com/HSMM/toolkit/internal/transcription"
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
	oauthHandlers := oauthhandlers.New(cfg, pool, logger, jwtIssuer)

	// LiveKit + meetings.
	var (
		meetingsHandlers *meetings.Handlers
		meetingsService  *meetings.Service
		lkClient         *livekitclient.Client
	)
	{
		var err error
		lkClient, err = livekitclient.New(livekitclient.Config{
			APIKey:    cfg.LiveKitAPIKey,
			APISecret: cfg.LiveKitAPISecret,
			URL:       cfg.LiveKitURL,
		})
		if err != nil {
			logger.Warn("livekit init failed; /meetings будет недоступен", "err", err)
		} else {
			publicWS := cfg.LiveKitPublicWS
			if publicWS == "" {
				logger.Warn("LIVEKIT_PUBLIC_WS_URL пуст — фронт не сможет подключиться к комнате")
			}
			meetingsService = meetings.New(pool, lkClient, publicWS)
			meetingsService.SetLogger(logger)
			meetingsHandlers = meetings.NewHandlers(meetingsService)
		}
	}

	// Storage + queue + transcription handlers.
	// MinIO connect non-fatal: модуль /transcripts отдаст 503 если недоступен.
	var transcriptionHandlers *transcription.Handlers
	storeClient, sErr := storage.New(ctx, storage.Config{
		Endpoint:  cfg.MinioEndpoint,
		AccessKey: cfg.MinioAccessKey,
		SecretKey: cfg.MinioSecretKey,
		UseSSL:    cfg.MinioUseSSL,
		Region:    cfg.MinioRegion,
		Buckets: storage.Buckets{
			Recordings: cfg.MinioBucketRecordings,
			Reports:    cfg.MinioBucketReports,
			Backups:    cfg.MinioBucketBackups,
		},
	})
	if sErr != nil {
		logger.Warn("storage init failed; /transcripts будет недоступен", "err", sErr)
	} else {
		jobsQ := queue.New(pool)
		gc, gErr := gigaam.New(cfg.GigaAMAPIURL, cfg.GigaAMAPIToken)
		if gErr != nil {
			logger.Warn("gigaam client init failed; transcription submit будет недоступен", "err", gErr)
		}
		_ = gc // клиент для api не нужен (только в worker), но проверим конфиг
		transcriptionHandlers = transcription.NewHandlers(
			transcription.New(pool, storeClient, jobsQ, logger),
		)

		// Подключаем recording к meetings service: LiveKit Egress будет лить
		// файлы в тот же MinIO бакет recordings (LK-egress контейнер ходит в
		// minio:9000 по docker-сети [internal]).
		if meetingsService != nil {
			s3Endpoint := cfg.MinioEndpoint
			if !strings.HasPrefix(s3Endpoint, "http") {
				s3Endpoint = "http://" + s3Endpoint
			}
			meetingsService.AttachRecording(meetings.RecordingDeps{
				S3: livekitclient.S3Config{
					AccessKey: cfg.MinioAccessKey, Secret: cfg.MinioSecretKey,
					Endpoint: s3Endpoint, Region: cfg.MinioRegion,
					Bucket: cfg.MinioBucketRecordings, ForcePathStyle: true,
				},
				Storage:           storeClient,
				VideoFilepathTmpl: "meetings/{room_name}/{time}.mp4",
				AudioFilepathTmpl: "meetings/{room_name}/{time}.ogg",
			})
		}
	}

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


	r.Route("/oauth", func(r chi.Router) {
		r.Get("/login", oauthHandlers.Login)
		r.Get("/callback", oauthHandlers.Callback)
		r.Post("/refresh", oauthHandlers.Refresh)
		r.Post("/install", oauthHandlers.Install)
		r.Post("/logout", oauthHandlers.Logout)
	})

	// --- /api/v1: публичные guest-роуты + Group с RequireAuth для остального ---
	r.Route("/api/v1", func(r chi.Router) {
		// Публичный гостевой доступ к встречам — без RequireAuth, только token из URL.
		if meetingsHandlers != nil {
			r.Mount("/guests", meetingsHandlers.GuestRoutes())
		}

		// LiveKit webhook — публичный (HMAC проверяется внутри handler'а).
		// Под /api/v1 чтобы NPM проксировал через стандартный /api/v1 mapping.
		if lkClient != nil && meetingsService != nil {
			r.Post("/livekit/webhook", handleLiveKitWebhook(lkClient, meetingsService, logger))
		}

		// Authenticated API.
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireAuth(jwtIssuer, subjectLoader, logger))
			r.Use(middleware.RateLimitByUser(cfg.RateLimitUserPerMin, time.Minute))

			r.Get("/me", handleMe(pool))

			// WebSocket events.
			r.Mount("/ws", ws.NewHandler(hub, cfg.AllowedCORSOrigins))

			if transcriptionHandlers != nil {
				r.Mount("/transcripts", transcriptionHandlers.Routes())
			}
			if meetingsHandlers != nil {
				r.Mount("/meetings", meetingsHandlers.Routes())
			}

			// Системные настройки — read-only для всех authenticated
			// (фронт фильтрует NAV по module_access).
			sysHandlers := sysset.NewHandlers(pool)
			r.Mount("/system-settings", sysHandlers.ReadRoutes())

			// Admin-only endpoints, доступные через /api/v1/admin/* (NPM
			// проксирует /api/v1 → api). Старая /admin/* группа (внизу)
			// тоже остаётся — для прямых запросов к api без NPM-проксирования.
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireRole(auth.RoleAdmin))
				r.Mount("/admin/users", admin.NewUsersHandlers(pool).Routes())
				r.Mount("/admin/system-settings", sysHandlers.WriteRoutes())
			})
		})
	})

	// --- Admin-only endpoints ---
	r.Route("/admin", func(r chi.Router) {
		r.Use(middleware.RequireAuth(jwtIssuer, subjectLoader, logger))
		r.Use(middleware.RequireRole(auth.RoleAdmin))
		r.Use(middleware.RateLimitByUser(cfg.RateLimitUserPerMin, time.Minute))

		r.Get("/queue/stats", stubHandler("queue stats endpoint not implemented yet"))
		r.Mount("/users", admin.NewUsersHandlers(pool).Routes())
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

// handleMe returns the calling subject's full profile (joined from "user"
// table — full name, department, position, phone, avatar, extension, bitrix_id).
func handleMe(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := auth.MustSubject(r.Context())

		var (
			bitrixID, fullName, phone string
			department, position      string
			avatarURL, extension      string
		)
		const q = `
			SELECT COALESCE(bitrix_id, ''), COALESCE(full_name, ''), COALESCE(phone, ''),
			       COALESCE(department, ''), COALESCE(position, ''),
			       COALESCE(avatar_url, ''), COALESCE(extension, '')
			FROM "user" WHERE id = $1
		`
		_ = pool.QueryRow(r.Context(), q, s.UserID).Scan(
			&bitrixID, &fullName, &phone, &department, &position, &avatarURL, &extension,
		)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":    s.UserID,
			"email":      s.Email,
			"role":       s.Role,
			"supervises": len(s.Supervises),
			"session_id": s.SessionID,
			"bitrix_id":  bitrixID,
			"full_name":  fullName,
			"phone":      phone,
			"department": department,
			"position":   position,
			"avatar_url": avatarURL,
			"extension":  extension,
		})
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

// handleLiveKitWebhook принимает события LiveKit (publicный, no auth, но с
// HMAC-проверкой через VerifyAndParseWebhook). На egress_ended вызывает
// meetings.OnEgressEnded — там создаётся recording row и enqueue'ится
// transcribe job. Остальные события сейчас игнорируем (но логируем).
func handleLiveKitWebhook(lk *livekitclient.Client, ms *meetings.Service, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ev, err := lk.VerifyAndParseWebhook(r)
		if err != nil {
			logger.Warn("livekit webhook reject", "err", err)
			http.Error(w, "invalid", http.StatusUnauthorized)
			return
		}
		switch ev.Event {
		case "egress_ended":
			if err := ms.OnEgressEnded(r.Context(), ev.EgressInfo); err != nil {
				logger.Error("OnEgressEnded", "err", err, "egress_id", egressID(ev))
				http.Error(w, "processing failed", http.StatusInternalServerError)
				return
			}
			logger.Info("egress_ended processed", "egress_id", egressID(ev))
		default:
			logger.Debug("livekit webhook", "event", ev.Event)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func egressID(ev *livekitclient.WebhookEvent) string {
	if ev == nil || ev.EgressInfo == nil {
		return ""
	}
	return ev.EgressInfo.EgressID
}
