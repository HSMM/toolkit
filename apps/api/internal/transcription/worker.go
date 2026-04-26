package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/gigaam"
	"github.com/HSMM/toolkit/internal/queue"
	"github.com/HSMM/toolkit/internal/storage"
)

// Worker — обработчик job kind="transcribe_recording".
//
// Жизненный цикл одной задачи:
//  1. Загрузить recording (s3_key) и transcript (status, gigaam_task_id).
//  2. Если task_id ещё не выдан → скачать аудио из MinIO, POST на GigaAM, сохранить task_id, status='processing'.
//  3. Опросить GET /stt/result/{task_id}.
//     - processing/queued → завершить worker без ошибки, вернуть Reschedule (через ErrSkip).
//        Однако наш Queue не имеет встроенного "soft reschedule" — поэтому
//        worker сам делает Q.Reschedule и возвращает ErrSkip handler'у, чтобы
//        runner Complete'нул эту задачу (новая создана через Reschedule).
//     - completed → сохранить сегменты, status='completed'.
//     - error    → status='failed' с сообщением.
type Worker struct {
	pool    *pgxpool.Pool
	storage *storage.Client
	gigaam  *gigaam.Client
	jobs    *queue.Queue
	log     *slog.Logger

	pollEvery time.Duration
	maxAge    time.Duration // максимальный TTL ожидания результата от GigaAM
}

// NewWorker собирает обработчик. pollEvery — период повторной постановки
// (например, 5–15 сек). maxAge — после какого возраста job помечать failed.
func NewWorker(pool *pgxpool.Pool, store *storage.Client, gc *gigaam.Client, q *queue.Queue, log *slog.Logger, pollEvery, maxAge time.Duration) *Worker {
	if pollEvery <= 0 {
		pollEvery = 10 * time.Second
	}
	if maxAge <= 0 {
		maxAge = 30 * time.Minute
	}
	return &Worker{
		pool:    pool,
		storage: store,
		gigaam:  gc,
		jobs:    q,
		log:     log,
		pollEvery: pollEvery,
		maxAge:    maxAge,
	}
}

// Handle — реализация queue.HandlerFunc для регистрации в worker'е.
func (w *Worker) Handle(ctx context.Context, payloadBytes []byte) error {
	var p jobPayload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return fmt.Errorf("transcribe handler: bad payload: %w", err)
	}
	logger := w.log.With("transcript_id", p.TranscriptID, "recording_id", p.RecordingID)

	// Прочитать состояние транскрипта.
	const sel = `
		SELECT t.status, COALESCE(t.gigaam_task_id, ''),
		       r.s3_bucket, r.s3_key, COALESCE(r.original_filename, ''),
		       t.created_at
		FROM transcript t JOIN recording r ON r.id = t.recording_id
		WHERE t.id = $1
	`
	var st Status
	var taskID, bucket, key, filename string
	var createdAt time.Time
	if err := w.pool.QueryRow(ctx, sel, p.TranscriptID).Scan(&st, &taskID, &bucket, &key, &filename, &createdAt); err != nil {
		return fmt.Errorf("transcribe handler: load transcript: %w", err)
	}
	_ = bucket // используем дефолтный recordings из storage.Client; bucket в БД для будущих доменов

	if st == StatusCompleted {
		logger.Info("transcript already completed, skipping")
		return &queue.ErrSkip{Reason: "already completed"}
	}

	// Защита от вечного polling.
	if time.Since(createdAt) > w.maxAge {
		w.markFailed(ctx, p.TranscriptID, fmt.Sprintf("polling timeout after %s", w.maxAge))
		return nil // job завершается успешно (failure записана в БД)
	}

	// Шаг 1: если task_id ещё не получен — submit.
	if taskID == "" {
		newTaskID, err := w.submit(ctx, key, filename)
		if err != nil {
			w.markFailed(ctx, p.TranscriptID, fmt.Sprintf("submit: %v", err))
			return err
		}
		if err := w.markProcessing(ctx, p.TranscriptID, newTaskID); err != nil {
			return fmt.Errorf("mark processing: %w", err)
		}
		taskID = newTaskID
	}

	// Шаг 2: опрос результата.
	res, err := w.gigaam.Poll(ctx, taskID)
	if err != nil {
		// Сетевая ошибка — пусть очередь повторит с backoff.
		return fmt.Errorf("poll gigaam: %w", err)
	}

	switch res.Status {
	case gigaam.StatusQueued, gigaam.StatusProcessing:
		// Реще не готово. Повторить через pollEvery (новый job).
		if _, err := w.jobs.Enqueue(ctx, JobKindTranscribeRecording, p,
			queue.WithDelay(w.pollEvery)); err != nil {
			return fmt.Errorf("reschedule: %w", err)
		}
		return &queue.ErrSkip{Reason: "still processing"}

	case gigaam.StatusCompleted:
		if res.Result == nil {
			w.markFailed(ctx, p.TranscriptID, "completed but empty result")
			return nil
		}
		if err := w.persist(ctx, p.TranscriptID, taskID, res); err != nil {
			return fmt.Errorf("persist: %w", err)
		}
		logger.Info("transcript completed", "segments", len(res.Result.Segments))
		return nil

	case gigaam.StatusError:
		w.markFailed(ctx, p.TranscriptID, "gigaam reported error")
		return nil

	default:
		// Неизвестный статус — лучше всего failed.
		w.markFailed(ctx, p.TranscriptID, fmt.Sprintf("unknown gigaam status: %s", res.Status))
		return nil
	}
}

func (w *Worker) submit(ctx context.Context, key, filename string) (string, error) {
	rc, err := w.storage.GetRecording(ctx, key)
	if err != nil {
		return "", fmt.Errorf("get from storage: %w", err)
	}
	defer rc.Close()
	if filename == "" {
		filename = "audio"
	}
	resp, err := w.gigaam.Submit(ctx, rc, filename)
	if err != nil {
		return "", err
	}
	return resp.TaskID, nil
}

func (w *Worker) markProcessing(ctx context.Context, id uuid.UUID, taskID string) error {
	const q = `
		UPDATE transcript
		SET status = 'processing', gigaam_task_id = $2, attempts = attempts + 1
		WHERE id = $1
	`
	_, err := w.pool.Exec(ctx, q, id, taskID)
	return err
}

func (w *Worker) markFailed(ctx context.Context, id uuid.UUID, msg string) {
	if _, err := w.pool.Exec(ctx,
		`UPDATE transcript SET status = 'failed', error_message = $2 WHERE id = $1`,
		id, msg,
	); err != nil {
		w.log.Error("mark failed: db update failed", "err", err, "transcript_id", id)
	}
}

func (w *Worker) persist(ctx context.Context, transcriptID uuid.UUID, taskID string, res *gigaam.PollResponse) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Сохраним сегменты. speaker_ref — channel:N если есть, иначе side:internal по умолчанию.
	const insSeg = `
		INSERT INTO transcript_segment (transcript_id, segment_no, speaker_ref, start_ms, end_ms, text)
		VALUES ($1, $2, $3, $4, $5, $6)
	`
	for _, seg := range res.Result.Segments {
		speaker := "side:internal"
		if seg.Channel != nil {
			speaker = fmt.Sprintf("channel:%d", *seg.Channel)
		}
		if _, err := tx.Exec(ctx, insSeg,
			transcriptID, seg.Segment, speaker,
			int(seg.Start*1000), int(seg.End*1000), seg.Text,
		); err != nil {
			return fmt.Errorf("insert segment: %w", err)
		}
	}

	// Сохраним метаданные транскрипта.
	rawMeta, _ := json.Marshal(map[string]any{
		"message":        res.Result.Message,
		"emo":            res.Result.Emo,
		"stt_model":      res.STTModel,
		"execution_time": res.ExecutionTime,
	})
	const updT = `
		UPDATE transcript SET
			status = 'completed',
			gigaam_task_id = $2,
			engine_metadata = $3::jsonb,
			engine_version = COALESCE(NULLIF($4, ''), engine_version),
			execution_time_ms = $5,
			error_message = NULL,
			completed_at = NOW()
		WHERE id = $1
	`
	if _, err := tx.Exec(ctx, updT, transcriptID, taskID, string(rawMeta), res.STTModel, int(res.ExecutionTime*1000)); err != nil {
		return fmt.Errorf("update transcript: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// Compile-time check that *Worker.Handle совместим с queue.HandlerFunc.
var _ queue.HandlerFunc = (&Worker{}).Handle

// для линтера (errors импорт намеренный).
var _ = errors.Is
