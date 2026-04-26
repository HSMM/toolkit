// Package worker is the entry point of the `toolkit worker` mode.
// Wires DB pool, job queue, MinIO storage, GigaAM client; регистрирует
// handlers очереди по доменам (E5/E7/E10).
package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/HSMM/toolkit/internal/config"
	"github.com/HSMM/toolkit/internal/db"
	"github.com/HSMM/toolkit/internal/gigaam"
	"github.com/HSMM/toolkit/internal/queue"
	"github.com/HSMM/toolkit/internal/storage"
	"github.com/HSMM/toolkit/internal/transcription"
)

func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	q := queue.New(pool)
	registry := queue.NewRegistry()

	// Транскрибация (E7.3 — для пользовательских загрузок; E7.4 для встреч добавится отдельно).
	if storeClient, sErr := storage.New(ctx, storage.Config{
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
	}); sErr != nil {
		logger.Warn("storage init failed; transcribe_recording handler не зарегистрирован", "err", sErr)
	} else if cfg.GigaAMAPIURL == "" {
		logger.Warn("GIGAAM_API_URL пуст; transcribe_recording handler не зарегистрирован")
	} else {
		gc, gErr := gigaam.New(cfg.GigaAMAPIURL, cfg.GigaAMAPIToken)
		if gErr != nil {
			logger.Warn("gigaam init failed; transcribe_recording handler не зарегистрирован", "err", gErr)
		} else {
			tw := transcription.NewWorker(pool, storeClient, gc, q, logger,
				time.Duration(cfg.GigaAMPollInterval)*time.Second, 30*time.Minute)
			registry.Register(transcription.JobKindTranscribeRecording, tw.Handle)
		}
	}

	// Прочие handlers — регистрируются по мере появления:
	//   E2.4: registry.Register("sync_users_bitrix24", ...)
	//   E5.10: registry.Register("import_cdr_freepbx", ...)
	//   E10.1: registry.Register("send_email", ...)

	logger.Info("worker handlers registered", "count", len(registry.Kinds()), "kinds", registry.Kinds())

	runner := queue.NewRunner(q, registry, logger, queue.RunnerOptions{
		Concurrency:  cfg.WorkerConcurrency,
		PollInterval: 1 * time.Second,
		IdleSleep:    2 * time.Second,
		JobTimeout:   10 * time.Minute,
	})

	return runner.Start(ctx)
}
