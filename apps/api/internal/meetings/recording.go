package meetings

// Recording-логика встречи (E5.2, composite-pivot v2):
// - Параллельно стартуем ДВА RoomCompositeEgress'а на встречу:
//     • видео+аудио (MP4) → meeting.current_egress_id        — для просмотра
//     • только аудио (OGG/Opus) → meeting.current_audio_egress_id — для GigaAM
// - host жмёт Start → оба egress; meeting.recording_active=true.
// - host жмёт Stop  → StopEgress на оба; recording_active=false.
// - egress_ended webhook идёт по каждому отдельно. Распознаём по тому, в какой
//   из двух колонок meeting лежит этот egress_id, и создаём соответствующую
//   recording-row:
//     • видео → kind='meeting_composite', mime='video/mp4', no transcribe
//     • аудио → kind='meeting_audio',     mime='audio/ogg', enqueue transcribe
//
// Per-track для каждого участника откладывается до решения по диаризации.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/livekit"
)

type RecordingDeps struct {
	S3                livekit.S3Config
	VideoFilepathTmpl string // "meetings/{room_name}/{time}.mp4"
	AudioFilepathTmpl string // "meetings/{room_name}/{time}.ogg"
}

func (s *Service) AttachRecording(deps RecordingDeps) {
	if deps.VideoFilepathTmpl == "" {
		deps.VideoFilepathTmpl = "meetings/{room_name}/{time}.mp4"
	}
	if deps.AudioFilepathTmpl == "" {
		deps.AudioFilepathTmpl = "meetings/{room_name}/{time}.ogg"
	}
	s.recDeps = &deps
}

var ErrRecordingNotConfigured = errors.New("recording not configured (MinIO/Egress)")

// StartRecording (host/admin) — стартует video+audio composite-egress.
// Идемпотентно: если хотя бы одна дорожка уже идёт — выходит без ошибки.
func (s *Service) StartRecording(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) error {
	if s.recDeps == nil {
		return ErrRecordingNotConfigured
	}
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return err
	}
	if !(subj.Role == auth.RoleAdmin || subj.UserID == m.CreatedBy) {
		return ErrForbidden
	}
	if m.EndedAt != nil {
		return ErrEnded
	}

	var (
		active                bool
		videoEg, audioEg      *string
	)
	if err := s.db.QueryRow(ctx, `
		SELECT recording_active, current_egress_id, current_audio_egress_id
		FROM meeting WHERE id=$1
	`, meetingID).Scan(&active, &videoEg, &audioEg); err != nil {
		return err
	}
	if active && videoEg != nil && *videoEg != "" {
		return nil // уже идёт
	}

	// Запускаем обе дорожки. Если вторая упала — первую нужно остановить,
	// чтобы не остался "зависший" видео-egress.
	videoID, err := s.lk.StartRoomCompositeEgress(ctx, m.LiveKitRoomID, "grid", s.recDeps.VideoFilepathTmpl, s.recDeps.S3)
	if err != nil {
		return fmt.Errorf("video egress: %w", err)
	}
	audioID, err := s.lk.StartRoomCompositeAudioEgress(ctx, m.LiveKitRoomID, s.recDeps.AudioFilepathTmpl, s.recDeps.S3)
	if err != nil {
		_ = s.lk.StopEgress(ctx, videoID)
		return fmt.Errorf("audio egress: %w", err)
	}

	if _, err := s.db.Exec(ctx, `
		UPDATE meeting
		   SET recording_active        = TRUE,
		       recording_started_at    = COALESCE(recording_started_at, NOW()),
		       current_egress_id       = $2,
		       current_audio_egress_id = $3
		 WHERE id = $1
	`, meetingID, videoID, audioID); err != nil {
		_ = s.lk.StopEgress(ctx, videoID)
		_ = s.lk.StopEgress(ctx, audioID)
		return fmt.Errorf("flag meeting active: %w", err)
	}
	return nil
}

// StopRecording (host/admin) — StopEgress на обе дорожки. Сами recording-rows
// создадутся на egress_ended webhook (для каждой отдельно).
func (s *Service) StopRecording(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) error {
	if s.recDeps == nil {
		return ErrRecordingNotConfigured
	}
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return err
	}
	if !(subj.Role == auth.RoleAdmin || subj.UserID == m.CreatedBy) {
		return ErrForbidden
	}

	var videoEg, audioEg *string
	if err := s.db.QueryRow(ctx, `
		SELECT current_egress_id, current_audio_egress_id FROM meeting WHERE id=$1
	`, meetingID).Scan(&videoEg, &audioEg); err != nil {
		return err
	}
	for _, id := range []*string{videoEg, audioEg} {
		if id != nil && *id != "" {
			if err := s.lk.StopEgress(ctx, *id); err != nil {
				s.logf("stop egress %s: %v", *id, err)
			}
		}
	}

	if _, err := s.db.Exec(ctx, `
		UPDATE meeting SET recording_active = FALSE WHERE id = $1
	`, meetingID); err != nil {
		return err
	}
	return nil
}

// MaybeStartEgressForParticipant — заглушка (composite не нуждается в фан-ауте).
func (s *Service) MaybeStartEgressForParticipant(ctx context.Context, meetingID uuid.UUID, identity string) {
	_ = ctx; _ = meetingID; _ = identity
}

// OnEgressEnded — webhook handler. Найдём встречу, у которой этот egress
// записан в video-колонке или в audio-колонке, и создадим recording row
// нужного типа.
func (s *Service) OnEgressEnded(ctx context.Context, info *livekit.EgressInfo) error {
	if info == nil || info.EgressID == "" {
		return errors.New("OnEgressEnded: empty egress info")
	}

	// Поиск: или video, или audio.
	const findQ = `
		SELECT id,
		       (current_egress_id       = $1) AS is_video,
		       (current_audio_egress_id = $1) AS is_audio
		FROM meeting
		WHERE current_egress_id = $1 OR current_audio_egress_id = $1
	`
	var (
		meetingID         uuid.UUID
		isVideo, isAudio  bool
	)
	err := s.db.QueryRow(ctx, findQ, info.EgressID).Scan(&meetingID, &isVideo, &isAudio)
	if errors.Is(err, pgx.ErrNoRows) {
		s.logf("OnEgressEnded: no meeting for egress %s (already cleared?)", info.EgressID)
		return nil
	}
	if err != nil {
		return err
	}

	var fr *livekit.FileResult
	if len(info.FileResults) > 0 {
		fr = info.FileResults[0]
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Сбрасываем pointer на эту дорожку (видео или аудио, в зависимости).
	if isVideo {
		if _, err := tx.Exec(ctx, `UPDATE meeting SET current_egress_id = NULL WHERE id = $1`, meetingID); err != nil {
			return err
		}
	}
	if isAudio {
		if _, err := tx.Exec(ctx, `UPDATE meeting SET current_audio_egress_id = NULL WHERE id = $1`, meetingID); err != nil {
			return err
		}
	}
	// recording_active=false когда обе дорожки закончились (оба pointer'а NULL).
	if _, err := tx.Exec(ctx, `
		UPDATE meeting SET recording_active = FALSE
		 WHERE id = $1 AND current_egress_id IS NULL AND current_audio_egress_id IS NULL
	`, meetingID); err != nil {
		return err
	}

	if fr == nil || fr.Filename == "" {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return fmt.Errorf("egress %s ended without file (status=%s, error=%s)", info.EgressID, info.Status, info.Error)
	}

	bucket, key := splitS3Path(fr.Filename, fr.Location, s.recDeps.S3.Bucket)
	if key == "" {
		return fmt.Errorf("can't derive S3 key from filename=%q location=%q", fr.Filename, fr.Location)
	}

	durationMs := fr.Duration / 1_000_000
	var (
		kind, mime, retentionKind string
	)
	if isVideo {
		kind, mime, retentionKind = "meeting_composite", "video/mp4", "meeting_composite"
	} else { // audio
		kind, mime, retentionKind = "meeting_audio", "audio/ogg", "meeting_audio"
	}

	const insRec = `
		INSERT INTO recording
		    (kind, meeting_id, s3_bucket, s3_key, mime_type,
		     size_bytes, duration_ms, is_stereo, retention_until)
		VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE,
		        NOW() + (COALESCE((SELECT default_days FROM retention_policy WHERE kind = $8), 30) || ' days')::interval)
		ON CONFLICT (s3_bucket, s3_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
		RETURNING id
	`
	var recordingID uuid.UUID
	if err := tx.QueryRow(ctx, insRec, kind, meetingID, bucket, key, mime, fr.Size, durationMs, retentionKind).Scan(&recordingID); err != nil {
		return fmt.Errorf("insert recording: %w", err)
	}

	// Транскрипция запускается ТОЛЬКО для аудио-дорожки.
	if isAudio {
		rawMeta, _ := json.Marshal(map[string]any{
			"egress_id":  info.EgressID,
			"meeting_id": meetingID,
			"size":       fr.Size, "duration_ns": fr.Duration,
		})
		var transcriptID uuid.UUID
		const insTx = `
			INSERT INTO transcript (recording_id, status, engine, engine_metadata, retention_until)
			SELECT $1, 'queued', 'gigaam', $2, r.retention_until + interval '30 days'
			  FROM recording r WHERE r.id = $1
			RETURNING id
		`
		if err := tx.QueryRow(ctx, insTx, recordingID, rawMeta).Scan(&transcriptID); err != nil {
			return fmt.Errorf("insert transcript: %w", err)
		}
		payload, _ := json.Marshal(map[string]any{
			"transcript_id": transcriptID,
			"recording_id":  recordingID,
		})
		if _, err := tx.Exec(ctx, `
			INSERT INTO job (kind, payload, run_after, max_attempts, priority)
			VALUES ('transcribe_recording', $1, NOW(), 5, 50)
		`, payload); err != nil {
			return fmt.Errorf("enqueue transcribe: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.logf("recording saved: meeting=%s kind=%s egress=%s s3=%s/%s",
		meetingID, kind, info.EgressID, bucket, key)
	return nil
}

// ─── helpers ─────────────────────────────────────────────────────────────

func splitS3Path(filename, location, defaultBucket string) (bucket, key string) {
	bucket = defaultBucket
	key = strings.TrimPrefix(filename, "/")
	if location == "" {
		return
	}
	if strings.HasPrefix(location, "s3://") {
		rest := strings.TrimPrefix(location, "s3://")
		if i := strings.Index(rest, "/"); i > 0 {
			bucket = rest[:i]
			key = rest[i+1:]
		}
		return
	}
	if u, err := url.Parse(location); err == nil && u.Path != "" {
		parts := strings.SplitN(strings.TrimPrefix(u.Path, "/"), "/", 2)
		if len(parts) == 2 {
			bucket = parts[0]
			key = parts[1]
		}
	}
	return
}

func (s *Service) logf(format string, args ...any) {
	_ = format; _ = args
}
