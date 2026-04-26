// Package transcription реализует пользовательский поток транскрибации:
// загрузка аудио → MinIO → запись в БД → постановка job → воркер шлёт в
// GigaAM, опрашивает, сохраняет сегменты.
//
// Покрывает E7.5 (ручная отправка) для kind='upload' (разовые файлы).
// Поток для звонков и встреч (E7.3/E7.4) — реализуется в отдельных
// доменных модулях, которые используют тот же Service.UploadAndQueue API.
package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/queue"
	"github.com/HSMM/toolkit/internal/storage"
)

// Status — состояние транскрипта в нашей БД (см. migration 000006).
type Status string

const (
	StatusPending    Status = "pending"
	StatusQueued     Status = "queued"
	StatusProcessing Status = "processing"
	StatusCompleted  Status = "completed"
	StatusPartial    Status = "partial"
	StatusFailed     Status = "failed"
)

// AllowedExt — расширения, которые принимаем при upload (поддерживаются
// GigaAM через ffmpeg). См. .env.example комментарий по форматам.
var AllowedExt = map[string]struct{}{
	".wav": {}, ".ogg": {}, ".mp3": {}, ".flac": {},
	".m4a": {}, ".aac": {}, ".mp4": {}, ".wma": {},
}

const MaxUploadBytes = 500 * 1024 * 1024 // 500 МБ — то же что в UI

// UploadInput — параметры загрузки от пользователя.
type UploadInput struct {
	UploaderID  uuid.UUID
	Filename    string
	ContentType string
	Size        int64
	Body        io.Reader
}

// UploadResult — что возвращаем после успешной загрузки.
type UploadResult struct {
	RecordingID  uuid.UUID
	TranscriptID uuid.UUID
	JobID        int64
}

// Service — фасад модуля. Не stateful; safe to share.
type Service struct {
	pool    *pgxpool.Pool
	storage *storage.Client
	jobs    *queue.Queue
	log     *slog.Logger
}

// New собирает сервис.
func New(pool *pgxpool.Pool, store *storage.Client, q *queue.Queue, log *slog.Logger) *Service {
	return &Service{pool: pool, storage: store, jobs: q, log: log}
}

// Logger возвращает logger сервиса (для handlers).
func (s *Service) Logger() *slog.Logger { return s.log }

// StreamAudio пишет содержимое объекта из MinIO в w с поддержкой Range.
// Использует minio.Object (ReadSeeker) + http.ServeContent.
func (s *Service) StreamAudio(ctx context.Context, w http.ResponseWriter, r *http.Request, v *View) error {
	if v.S3Key == "" {
		return errors.New("transcription: empty s3_key")
	}
	rc, err := s.storage.GetRecording(ctx, v.S3Key)
	if err != nil {
		http.Error(w, "audio not available", http.StatusNotFound)
		return fmt.Errorf("get from storage: %w", err)
	}
	defer rc.Close()

	// minio.Object реализует io.ReadSeeker — http.ServeContent умеет с ним.
	rs, ok := rc.(io.ReadSeeker)
	if !ok {
		// fallback: прочитаем весь объект и отдадим без Range support.
		data, rerr := io.ReadAll(rc)
		if rerr != nil {
			return fmt.Errorf("read all: %w", rerr)
		}
		w.Header().Set("Content-Type", v.MimeType)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
		_, _ = w.Write(data)
		return nil
	}

	w.Header().Set("Content-Type", v.MimeType)
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, v.Filename, v.UploadedAt, rs)
	return nil
}

// Upload принимает файл, валидирует, кладёт в MinIO, создаёт recording +
// transcript (status=queued), ставит джоб transcribe_recording.
func (s *Service) Upload(ctx context.Context, in UploadInput) (*UploadResult, error) {
	ext := strings.ToLower(filepath.Ext(in.Filename))
	if _, ok := AllowedExt[ext]; !ok {
		return nil, fmt.Errorf("transcription: unsupported file extension %q", ext)
	}
	if in.Size > 0 && in.Size > MaxUploadBytes {
		return nil, fmt.Errorf("transcription: file too large (%d bytes, max %d)", in.Size, MaxUploadBytes)
	}
	if in.UploaderID == uuid.Nil {
		return nil, errors.New("transcription: empty uploader id")
	}

	recordingID := uuid.New()
	transcriptID := uuid.New()
	objKey := fmt.Sprintf("uploads/%s/%s%s", in.UploaderID, recordingID, ext)

	bucket, key, size, err := s.storage.PutRecording(ctx, objKey, in.Body, storage.PutOpts{
		ContentType: contentTypeOr(in.ContentType, ext),
		Size:        in.Size,
	})
	if err != nil {
		return nil, fmt.Errorf("transcription: store object: %w", err)
	}

	// Транзакция: recording + transcript + job — атомарно.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		_ = s.storage.DeleteRecording(ctx, key) // компенсация — оставлять orphan не нужно
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Recording (kind=upload, retention default из политики)
	const insRecording = `
		INSERT INTO recording (id, kind, s3_bucket, s3_key, size_bytes, mime_type,
		                       retention_until, uploaded_by, original_filename)
		VALUES ($1, 'upload', $2, $3, $4, $5,
		        NOW() + ((SELECT default_days FROM retention_policy WHERE kind = 'transcript') || ' days')::interval,
		        $6, $7)
	`
	if _, err := tx.Exec(ctx, insRecording,
		recordingID, bucket, key, size, contentTypeOr(in.ContentType, ext),
		in.UploaderID, in.Filename,
	); err != nil {
		_ = s.storage.DeleteRecording(ctx, key)
		return nil, fmt.Errorf("transcription: insert recording: %w", err)
	}

	const insTranscript = `
		INSERT INTO transcript (id, recording_id, status, engine, retention_until)
		SELECT $1, $2, 'queued', 'gigaam', r.retention_until + interval '30 days'
		FROM recording r WHERE r.id = $2
	`
	if _, err := tx.Exec(ctx, insTranscript, transcriptID, recordingID); err != nil {
		_ = s.storage.DeleteRecording(ctx, key)
		return nil, fmt.Errorf("transcription: insert transcript: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		_ = s.storage.DeleteRecording(ctx, key)
		return nil, err
	}

	// Постановка job (после commit — чтобы worker не подхватил раньше времени).
	jobID, err := s.jobs.Enqueue(ctx, JobKindTranscribeRecording, jobPayload{
		TranscriptID: transcriptID,
		RecordingID:  recordingID,
	})
	if err != nil {
		s.log.Error("transcription: enqueue job failed", "err", err, "transcript_id", transcriptID)
		// Транскрипт остался в queued — пользователь может вручную retry через handler.
	}

	return &UploadResult{
		RecordingID:  recordingID,
		TranscriptID: transcriptID,
		JobID:        jobID,
	}, nil
}

// View — данные для UI (один транскрипт).
type View struct {
	ID               uuid.UUID       `json:"id"`
	RecordingID      uuid.UUID       `json:"recording_id"`
	Filename         string          `json:"filename"`
	SizeBytes        int64           `json:"size_bytes"`
	MimeType         string          `json:"mime_type"`
	UploadedBy       uuid.UUID       `json:"uploaded_by"`
	UploadedAt       time.Time       `json:"uploaded_at"`
	Status           Status          `json:"status"`
	Engine           string          `json:"engine"`
	EngineVersion    string          `json:"engine_version,omitempty"`
	GigaAMTaskID     string          `json:"gigaam_task_id,omitempty"`
	ExecutionTimeMs  int             `json:"execution_time_ms,omitempty"`
	ErrorMessage     string          `json:"error_message,omitempty"`
	Attempts         int             `json:"attempts"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
	Segments         []SegmentDTO    `json:"segments,omitempty"`
	EngineMetadata   json.RawMessage `json:"-"` // не отдаём в /me list, читаем для analytics
	S3Bucket         string          `json:"-"` // для StreamAudio
	S3Key            string          `json:"-"`
}

// SegmentDTO — один сегмент для UI.
type SegmentDTO struct {
	ID         uuid.UUID `json:"id"`
	SegmentNo  int       `json:"segment_no"`
	SpeakerRef string    `json:"speaker_ref"`
	StartMs    int       `json:"start_ms"`
	EndMs      int       `json:"end_ms"`
	Text       string    `json:"text"`
	IsEdited   bool      `json:"is_edited"`
	Version    int       `json:"version"`
}

// ListByUser — транскрипции, доступные пользователю:
//   • uploads: где он сам загружал файл (kind='upload', uploaded_by=user)
//   • meeting per-track: где он создатель встречи или participant
// Если meetingFilter != nil — фильтрует только по указанной встрече
// (с тем же RBAC: user должен иметь доступ к встрече).
func (s *Service) ListByUser(ctx context.Context, userID uuid.UUID, limit int, meetingFilter *uuid.UUID) ([]View, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{userID, limit}
	meetingClause := ""
	if meetingFilter != nil {
		meetingClause = " AND r.meeting_id = $3"
		args = append(args, *meetingFilter)
	}
	q := `
		SELECT t.id, t.recording_id,
		       COALESCE(r.original_filename, COALESCE(p.external_name, '')) AS display_name,
		       COALESCE(r.size_bytes, 0), COALESCE(r.mime_type, ''),
		       r.uploaded_by, r.created_at,
		       t.status, t.engine, COALESCE(t.engine_version, ''),
		       COALESCE(t.gigaam_task_id, ''), COALESCE(t.execution_time_ms, 0),
		       COALESCE(t.error_message, ''), t.attempts, t.completed_at
		FROM transcript t
		JOIN recording  r ON r.id = t.recording_id
		LEFT JOIN participant p ON p.id = r.participant_id
		WHERE (
		    (r.kind = 'upload' AND r.uploaded_by = $1)
		    OR
		    (r.kind = 'meeting_per_track' AND EXISTS (
		        SELECT 1 FROM meeting m
		        WHERE m.id = r.meeting_id
		          AND (m.created_by = $1 OR EXISTS (
		              SELECT 1 FROM participant pp WHERE pp.meeting_id = m.id AND pp.user_id = $1))
		    ))
		)` + meetingClause + `
		ORDER BY r.created_at DESC
		LIMIT $2
	`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]View, 0, limit)
	for rows.Next() {
		var v View
		if err := rows.Scan(
			&v.ID, &v.RecordingID,
			&v.Filename, &v.SizeBytes, &v.MimeType,
			&v.UploadedBy, &v.UploadedAt,
			&v.Status, &v.Engine, &v.EngineVersion,
			&v.GigaAMTaskID, &v.ExecutionTimeMs,
			&v.ErrorMessage, &v.Attempts, &v.CompletedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// Get — транскрипт + сегменты. Авторизация — на handler-уровне.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (*View, error) {
	const headerQ = `
		SELECT t.id, t.recording_id,
		       COALESCE(r.original_filename, ''), COALESCE(r.size_bytes, 0), COALESCE(r.mime_type, ''),
		       COALESCE(r.uploaded_by, '00000000-0000-0000-0000-000000000000'::uuid), r.created_at,
		       t.status, t.engine, COALESCE(t.engine_version, ''),
		       COALESCE(t.gigaam_task_id, ''), COALESCE(t.execution_time_ms, 0),
		       COALESCE(t.error_message, ''), t.attempts, t.completed_at,
		       t.engine_metadata, r.s3_bucket, r.s3_key
		FROM transcript t
		JOIN recording  r ON r.id = t.recording_id
		WHERE t.id = $1
	`
	v := &View{}
	var engineMeta []byte
	if err := s.pool.QueryRow(ctx, headerQ, id).Scan(
		&v.ID, &v.RecordingID,
		&v.Filename, &v.SizeBytes, &v.MimeType,
		&v.UploadedBy, &v.UploadedAt,
		&v.Status, &v.Engine, &v.EngineVersion,
		&v.GigaAMTaskID, &v.ExecutionTimeMs,
		&v.ErrorMessage, &v.Attempts, &v.CompletedAt,
		&engineMeta, &v.S3Bucket, &v.S3Key,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	v.EngineMetadata = engineMeta

	const segQ = `
		SELECT id, segment_no, speaker_ref, start_ms, end_ms, text, is_edited, version
		FROM transcript_segment WHERE transcript_id = $1
		ORDER BY start_ms
	`
	rows, err := s.pool.Query(ctx, segQ, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var s SegmentDTO
		if err := rows.Scan(&s.ID, &s.SegmentNo, &s.SpeakerRef, &s.StartMs, &s.EndMs, &s.Text, &s.IsEdited, &s.Version); err != nil {
			return nil, err
		}
		v.Segments = append(v.Segments, s)
	}
	return v, nil
}

// Retry — поставить новый job для transcript'а в статусе failed/partial.
func (s *Service) Retry(ctx context.Context, transcriptID uuid.UUID) error {
	const upd = `
		UPDATE transcript SET status = 'queued', error_message = NULL
		WHERE id = $1 AND status IN ('failed', 'partial')
		RETURNING recording_id
	`
	var recID uuid.UUID
	if err := s.pool.QueryRow(ctx, upd, transcriptID).Scan(&recID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotRetryable
		}
		return err
	}
	if _, err := s.jobs.Enqueue(ctx, JobKindTranscribeRecording, jobPayload{
		TranscriptID: transcriptID,
		RecordingID:  recID,
	}); err != nil {
		return fmt.Errorf("retry: enqueue: %w", err)
	}
	return nil
}

// Delete — удаляет транскрипт + recording (если kind=upload и owner=userID).
// Каскадно сегменты и ревизии удаляются триггерами/FK.
func (s *Service) Delete(ctx context.Context, transcriptID, byUser uuid.UUID) error {
	const sel = `
		SELECT r.id, r.s3_bucket, r.s3_key
		FROM transcript t JOIN recording r ON r.id = t.recording_id
		WHERE t.id = $1 AND r.kind = 'upload' AND r.uploaded_by = $2
	`
	var recID uuid.UUID
	var bucket, key string
	if err := s.pool.QueryRow(ctx, sel, transcriptID, byUser).Scan(&recID, &bucket, &key); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	// Сначала из БД (recording → cascade transcript+segments), потом из S3.
	if _, err := s.pool.Exec(ctx, `DELETE FROM recording WHERE id = $1`, recID); err != nil {
		return err
	}
	if err := s.storage.DeleteRecording(ctx, key); err != nil {
		// Не критично: orphan-объект подберёт retention cleanup.
		s.log.Warn("transcription: delete s3 object failed", "err", err, "key", key)
	}
	return nil
}

// Errors

var (
	ErrNotFound     = errors.New("transcript not found")
	ErrNotRetryable = errors.New("transcript not in retryable state")
)

// JobKindTranscribeRecording — kind очереди для нашего worker.
const JobKindTranscribeRecording = "transcribe_recording"

type jobPayload struct {
	TranscriptID uuid.UUID `json:"transcript_id"`
	RecordingID  uuid.UUID `json:"recording_id"`
}

// MarshalJSON — для удобства логов/тестов.
func (p jobPayload) MarshalJSON() ([]byte, error) {
	type alias jobPayload
	return json.Marshal(alias(p))
}

func contentTypeOr(ct, ext string) string {
	if ct != "" && ct != "application/octet-stream" {
		return ct
	}
	switch ext {
	case ".wav":  return "audio/wav"
	case ".mp3":  return "audio/mpeg"
	case ".ogg":  return "audio/ogg"
	case ".flac": return "audio/flac"
	case ".m4a", ".mp4": return "audio/mp4"
	case ".aac":  return "audio/aac"
	case ".wma":  return "audio/x-ms-wma"
	}
	return "application/octet-stream"
}
