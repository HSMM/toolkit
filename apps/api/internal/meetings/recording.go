package meetings

// Recording-логика встречи (E5.2):
// - host вызывает StartRecording → стартуем ParticipantEgress (audio_only) для
//   каждого ACTIVE participant'а в LK комнате; egress_id сохраняем в participant.
//   meeting.recording_active=true, recording_started_at=NOW().
// - на admit/join нового participant'а (когда recording_active) — стартуем для него.
// - host вызывает StopRecording → StopEgress для всех participant.current_egress_id;
//   meeting.recording_active=false. (started_at/started_at трогаем для повторного start.)
// - вебхук egress_ended вызывает Service.OnEgressEnded:
//     · находим participant по current_egress_id
//     · вытаскиваем s3 key из FileResult.Filename / Location
//     · INSERT recording (kind='meeting_per_track', meeting_id, participant_id)
//     · enqueue job 'transcribe_recording' с recording_id
//     · participant.current_egress_id = NULL

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

// RecordingDeps — то, что нужно сервису для записи. Передаётся отдельно от
// обычных meetings.New(), чтобы базовый функционал работал даже если MinIO/queue
// недоступны.
type RecordingDeps struct {
	S3            livekit.S3Config // куда writer'ы заливают файлы
	BucketKeyTmpl string           // напр. "meetings/{room_name}/{publisher_identity}-{time}.ogg"
}

// AttachRecording настраивает зависимости для записи. Вызывается в server.go
// после New(). Если не вызвать — record/start вернёт ErrRecordingNotConfigured.
func (s *Service) AttachRecording(deps RecordingDeps) {
	s.recDeps = &deps
}

// recDeps лежит в Service struct (см. service.go — добавим).

var ErrRecordingNotConfigured = errors.New("recording not configured (MinIO/Egress)")

// StartRecording (host или admin) — стартует ParticipantEgress для всех
// ACTIVE participant'ов в LK-комнате. Идемпотентно: уже идущая запись → no-op.
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
	// Идемпотентность.
	var active bool
	if err := s.db.QueryRow(ctx, `SELECT recording_active FROM meeting WHERE id=$1`, meetingID).Scan(&active); err != nil {
		return err
	}
	if active {
		return nil
	}

	parts, err := s.lk.ListParticipants(ctx, m.LiveKitRoomID)
	if err != nil {
		return fmt.Errorf("list participants: %w", err)
	}

	// Для каждого ACTIVE participant'а стартуем egress.
	for _, lkp := range parts {
		if !isActive(lkp.State) {
			continue
		}
		if err := s.startEgressFor(ctx, m.LiveKitRoomID, lkp.Identity); err != nil {
			s.logf("startEgressFor %s: %v", lkp.Identity, err)
			// продолжаем — пусть хотя бы остальные запишутся
		}
	}

	if _, err := s.db.Exec(ctx, `
		UPDATE meeting SET recording_active = TRUE, recording_started_at = COALESCE(recording_started_at, NOW())
		WHERE id = $1
	`, meetingID); err != nil {
		return fmt.Errorf("flag meeting active: %w", err)
	}
	return nil
}

// StopRecording — host/admin: StopEgress для всех participant.current_egress_id;
// recording_active=false. Сами recording-rows создадутся на egress_ended webhook.
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

	rows, err := s.db.Query(ctx, `
		SELECT current_egress_id FROM participant
		 WHERE meeting_id = $1 AND current_egress_id IS NOT NULL
	`, meetingID)
	if err != nil {
		return err
	}
	var egressIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		egressIDs = append(egressIDs, id)
	}
	rows.Close()

	for _, eid := range egressIDs {
		if err := s.lk.StopEgress(ctx, eid); err != nil {
			s.logf("stop egress %s: %v", eid, err)
		}
	}

	if _, err := s.db.Exec(ctx, `UPDATE meeting SET recording_active = FALSE WHERE id = $1`, meetingID); err != nil {
		return err
	}
	return nil
}

// MaybeStartEgressForParticipant — внутренний хук. Вызывается из Join (host
// зашёл) и AdmitGuest (гость допущен). Если для встречи запись активна —
// автоматически стартует egress для нового participant'а.
func (s *Service) MaybeStartEgressForParticipant(ctx context.Context, meetingID uuid.UUID, identity string) {
	if s.recDeps == nil {
		return
	}
	var (
		active   bool
		roomName string
	)
	err := s.db.QueryRow(ctx, `SELECT recording_active, livekit_room_id FROM meeting WHERE id=$1`, meetingID).Scan(&active, &roomName)
	if err != nil || !active {
		return
	}
	if err := s.startEgressFor(ctx, roomName, identity); err != nil {
		s.logf("auto-start egress for %s: %v", identity, err)
	}
}

// startEgressFor — общий низкий уровень: вызывает LiveKit, получает egress_id,
// сохраняет в participant.current_egress_id (по identity).
func (s *Service) startEgressFor(ctx context.Context, room, identity string) error {
	if s.recDeps == nil {
		return ErrRecordingNotConfigured
	}
	filepath := s.recDeps.BucketKeyTmpl
	if filepath == "" {
		filepath = "meetings/{room_name}/{publisher_identity}-{time}.ogg"
	}
	egressID, err := s.lk.StartParticipantAudioEgress(ctx, room, identity, filepath, s.recDeps.S3)
	if err != nil {
		return fmt.Errorf("StartParticipantEgress: %w", err)
	}
	// Запоминаем egress_id у соответствующего participant'а
	// (matched по meeting+livekit_identity; UPDATE безопасен — если строки нет, ничего не случится).
	_, err = s.db.Exec(ctx, `
		UPDATE participant SET current_egress_id = $3
		 WHERE meeting_id = (SELECT id FROM meeting WHERE livekit_room_id = $1)
		   AND livekit_identity = $2
		   AND current_egress_id IS NULL
	`, room, identity, egressID)
	return err
}

// OnEgressEnded — handler для webhook egress_ended.
// Создаёт recording row + ставит job на транскрипцию.
func (s *Service) OnEgressEnded(ctx context.Context, info *livekit.EgressInfo) error {
	if info == nil || info.EgressID == "" {
		return errors.New("OnEgressEnded: empty egress info")
	}
	// Найти participant по egress_id.
	const findQ = `
		SELECT p.id, p.meeting_id, p.is_guest, p.user_id
		FROM participant p
		WHERE p.current_egress_id = $1
	`
	var (
		participantID, meetingID uuid.UUID
		isGuest                  bool
		userID                   *uuid.UUID
	)
	err := s.db.QueryRow(ctx, findQ, info.EgressID).Scan(&participantID, &meetingID, &isGuest, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		s.logf("OnEgressEnded: no participant for egress %s (already cleared?)", info.EgressID)
		return nil
	}
	if err != nil {
		return err
	}

	var fr *livekit.FileResult
	if len(info.FileResults) > 0 {
		fr = info.FileResults[0]
	}
	if fr == nil || fr.Filename == "" {
		// Egress упал до файла. Чистим pointer и выходим.
		_, _ = s.db.Exec(ctx, `UPDATE participant SET current_egress_id = NULL WHERE id = $1`, participantID)
		return fmt.Errorf("egress %s ended without file result (status=%s, error=%s)", info.EgressID, info.Status, info.Error)
	}

	bucket, key := splitS3Path(fr.Filename, fr.Location, s.recDeps.S3.Bucket)
	if key == "" {
		return fmt.Errorf("can't derive S3 key from filename=%q location=%q", fr.Filename, fr.Location)
	}

	// engine_metadata храним сырой JSON для дебага/аналитики
	rawMeta, _ := json.Marshal(map[string]any{
		"egress_id": info.EgressID, "status": info.Status,
		"started_at": info.StartedAt, "ended_at": info.EndedAt,
		"size": fr.Size, "duration_ns": fr.Duration,
	})

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// 1) Сбрасываем pointer.
	if _, err := tx.Exec(ctx, `UPDATE participant SET current_egress_id = NULL WHERE id = $1`, participantID); err != nil {
		return err
	}

	// 2) Создаём recording. retention_until — из retention_policy('meeting_per_track').
	durationMs := fr.Duration / 1_000_000
	var recordingID uuid.UUID
	const insRec = `
		INSERT INTO recording
		    (kind, meeting_id, participant_id, s3_bucket, s3_key, mime_type,
		     size_bytes, duration_ms, is_stereo, retention_until)
		VALUES ('meeting_per_track', $1, $2, $3, $4, 'audio/ogg', $5, $6, FALSE,
		        NOW() + (COALESCE((SELECT default_days FROM retention_policy WHERE kind='meeting_per_track'), 0) || ' days')::interval)
		ON CONFLICT (s3_bucket, s3_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
		RETURNING id
	`
	if err := tx.QueryRow(ctx, insRec, meetingID, participantID, bucket, key, fr.Size, durationMs).Scan(&recordingID); err != nil {
		return fmt.Errorf("insert recording: %w", err)
	}

	// 3) Создаём transcript row + enqueue job.
	// speaker_ref для будущих сегментов default'ится по типу участника (хранится в engine_metadata).
	speakerRef := ""
	if isGuest {
		speakerRef = "guest:" + participantID.String()
	} else if userID != nil {
		speakerRef = "user:" + userID.String()
	}
	rawMeta2, _ := json.Marshal(map[string]any{
		"egress_id": info.EgressID, "default_speaker_ref": speakerRef,
		"meeting_id": meetingID, "size": fr.Size, "duration_ns": fr.Duration,
	})
	_ = rawMeta // used in line above as placeholder
	var transcriptID uuid.UUID
	const insTx = `
		INSERT INTO transcript (recording_id, status, engine, engine_metadata, retention_until)
		SELECT $1, 'queued', 'gigaam', $2,
		       r.retention_until + interval '30 days'
		  FROM recording r WHERE r.id = $1
		RETURNING id
	`
	if err := tx.QueryRow(ctx, insTx, recordingID, rawMeta2).Scan(&transcriptID); err != nil {
		return fmt.Errorf("insert transcript: %w", err)
	}

	// 4) Ставим job на транскрипцию.
	payload, _ := json.Marshal(map[string]any{
		"transcript_id": transcriptID,
		"recording_id":  recordingID,
	})
	const enqueue = `
		INSERT INTO job (kind, payload, run_after, max_attempts, priority)
		VALUES ('transcribe_recording', $1, NOW(), 5, 50)
	`
	if _, err := tx.Exec(ctx, enqueue, payload); err != nil {
		return fmt.Errorf("enqueue transcribe: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.logf("recording saved: meeting=%s participant=%s egress=%s s3=%s/%s",
		meetingID, participantID, info.EgressID, bucket, key)
	return nil
}

// ─── helpers ─────────────────────────────────────────────────────────────

func isActive(state string) bool {
	// LK enum: JOINED / ACTIVE / DISCONNECTED. Для записи нам нужны те, у кого
	// есть treki — проще брать всех кроме DISCONNECTED.
	return state != "" && state != "DISCONNECTED"
}

// splitS3Path пытается извлечь (bucket, key) из FileResult.
// LiveKit может вернуть Filename как просто ключ, либо location как полный URL.
func splitS3Path(filename, location, defaultBucket string) (bucket, key string) {
	bucket = defaultBucket
	key = strings.TrimPrefix(filename, "/")
	if location == "" {
		return
	}
	// s3://bucket/key
	if strings.HasPrefix(location, "s3://") {
		rest := strings.TrimPrefix(location, "s3://")
		if i := strings.Index(rest, "/"); i > 0 {
			bucket = rest[:i]
			key = rest[i+1:]
		}
		return
	}
	// http(s)://endpoint/bucket/key
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
	// Сервису пока не передан logger; оставим простую заглушку, вынесем при необходимости.
	_ = format; _ = args
}

