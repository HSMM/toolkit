// Package worker is the entry point of the `toolkit worker` mode.
// It wires the database pool, the job queue, and registers all background-task
// handlers (CDR import, GigaAM transcription, Bitrix24 sync, email, retention
// cleanup). Handlers themselves live in their domain packages and are added
// via init-style functions invoked from here as the codebase grows (E2/E5/E7/E10).
package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/softservice/toolkit/internal/config"
	"github.com/softservice/toolkit/internal/db"
	"github.com/softservice/toolkit/internal/queue"
)

func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	q := queue.New(pool)
	registry := queue.NewRegistry()

	// Handlers are registered as their domains land:
	//   E2.4: registry.Register("sync_users_bitrix24",     bitrix24.NewUsersSyncHandler(...))
	//   E2.5: registry.Register("sync_contacts_bitrix24",  bitrix24.NewContactsSyncHandler(...))
	//   E5.10: registry.Register("import_cdr_freepbx",     freepbx.NewCDRImportHandler(...))
	//   E5.11: registry.Register("import_recording_freepbx", freepbx.NewRecordingImportHandler(...))
	//   E6.13: registry.Register("upload_meeting_recording", livekit.NewUploadHandler(...))
	//   E7.3:  registry.Register("transcribe_recording",   gigaam.NewTranscribeHandler(...))
	//   E7.4:  registry.Register("transcribe_meeting",     gigaam.NewMeetingTranscribeHandler(...))
	//   E10.1: registry.Register("send_email",             email.NewSendHandler(...))
	//   retention cleanup task — registered separately as a periodic scheduler.
	logger.Info("worker handlers registered", "count", len(registry.Kinds()), "kinds", registry.Kinds())

	runner := queue.NewRunner(q, registry, logger, queue.RunnerOptions{
		Concurrency:  cfg.WorkerConcurrency,
		PollInterval: 1 * time.Second,
		IdleSleep:    2 * time.Second,
		JobTimeout:   10 * time.Minute,
	})

	return runner.Start(ctx)
}
