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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/livekit"
	"github.com/HSMM/toolkit/internal/storage"
)

type RecordingDeps struct {
	S3                livekit.S3Config
	Storage           *storage.Client // для скачивания готовых файлов через api
	VideoFilepathTmpl string          // "meetings/{room_name}/{time}.mp4"
	AudioFilepathTmpl string          // "meetings/{room_name}/{time}.ogg"
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

	sizeBytes := fr.SizeBytes()
	durationMs := fr.DurationNs() / 1_000_000
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
	if err := tx.QueryRow(ctx, insRec, kind, meetingID, bucket, key, mime, sizeBytes, durationMs, retentionKind).Scan(&recordingID); err != nil {
		return fmt.Errorf("insert recording: %w", err)
	}

	// Транскрипция запускается ТОЛЬКО для аудио-дорожки.
	if isAudio {
		rawMeta, _ := json.Marshal(map[string]any{
			"egress_id":  info.EgressID,
			"meeting_id": meetingID,
			"size":       sizeBytes, "duration_ns": fr.DurationNs(),
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

// ─── список и скачивание готовых файлов ─────────────────────────────────

// RecordingFile — публичная карточка записи для UI (без чувствительных полей).
type RecordingFile struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"`        // meeting_composite | meeting_audio | meeting_per_track
	MimeType   string    `json:"mime_type"`
	SizeBytes  int64     `json:"size_bytes"`
	DurationMs int64     `json:"duration_ms"`
	CreatedAt  time.Time `json:"created_at"`
	// Имя для Save-As (генерится из kind + meeting + timestamp).
	Filename string `json:"filename"`
}

// ListRecordings — все записи встречи. Доступ: admin, host (creator) или
// participant встречи.
func (s *Service) ListRecordings(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) ([]RecordingFile, error) {
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return nil, err
	}
	parts, err := s.loadParticipants(ctx, meetingID)
	if err != nil {
		return nil, err
	}
	if !canViewMeeting(subj, m, parts) {
		return nil, ErrForbidden
	}

	const q = `
		SELECT id, kind, mime_type, COALESCE(size_bytes,0), COALESCE(duration_ms,0),
		       created_at, s3_key
		FROM recording
		WHERE meeting_id = $1 AND kind IN ('meeting_composite','meeting_audio','meeting_per_track')
		ORDER BY (kind = 'meeting_composite') DESC, created_at DESC
	`
	rows, err := s.db.Query(ctx, q, meetingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RecordingFile, 0, 4)
	for rows.Next() {
		var (
			rec    RecordingFile
			s3Key  string
		)
		if err := rows.Scan(&rec.ID, &rec.Kind, &rec.MimeType, &rec.SizeBytes, &rec.DurationMs, &rec.CreatedAt, &s3Key); err != nil {
			return nil, err
		}
		rec.Filename = friendlyFilename(m, rec.Kind, s3Key)
		out = append(out, rec)
	}
	return out, rows.Err()
}

// StreamRecording — стримит файл из MinIO (с Range-поддержкой) и заголовком
// Content-Disposition: attachment, чтобы браузер сразу предлагал «Сохранить как».
func (s *Service) StreamRecording(ctx context.Context, subj *auth.Subject, w http.ResponseWriter, r *http.Request, meetingID, recordingID uuid.UUID) error {
	if s.recDeps == nil || s.recDeps.Storage == nil {
		return ErrRecordingNotConfigured
	}
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return err
	}
	parts, err := s.loadParticipants(ctx, meetingID)
	if err != nil {
		return err
	}
	if !canViewMeeting(subj, m, parts) {
		return ErrForbidden
	}

	const q = `
		SELECT s3_key, mime_type, kind, COALESCE(size_bytes,0), created_at
		FROM recording WHERE id = $1 AND meeting_id = $2
	`
	var (
		s3Key, mime, kind string
		size              int64
		createdAt         time.Time
	)
	err = s.db.QueryRow(ctx, q, recordingID, meetingID).Scan(&s3Key, &mime, &kind, &size, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}

	rc, err := s.recDeps.Storage.GetRecording(ctx, s3Key)
	if err != nil {
		return fmt.Errorf("storage get: %w", err)
	}
	defer rc.Close()
	rs, ok := rc.(io.ReadSeeker)
	if !ok {
		// Fallback: вычитываем целиком в память (Egress-файлы небольшие, но
		// до GB-видео не должно дойти).
		buf, rerr := io.ReadAll(rc)
		if rerr != nil {
			return fmt.Errorf("read all: %w", rerr)
		}
		rs = bytes.NewReader(buf)
	}

	filename := friendlyFilename(m, kind, s3Key)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	http.ServeContent(w, r, filename, createdAt, rs)
	return nil
}

func friendlyFilename(m *Meeting, kind, s3Key string) string {
	ext := strings.ToLower(path.Ext(s3Key))
	if ext == "" {
		switch kind {
		case "meeting_audio":
			ext = ".ogg"
		default:
			ext = ".mp4"
		}
	}
	ts := m.CreatedAt.Format("2006-01-02_1504")
	if m.RecordingStartedAt != nil {
		ts = m.RecordingStartedAt.Format("2006-01-02_1504")
	}
	title := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == '_' || (r >= '0' && r <= '9') ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= 'А' && r <= 'я') || r == 'Ё' || r == 'ё' {
			return r
		}
		return '_'
	}, m.Title)
	if title == "" {
		title = "meeting"
	}
	suffix := ""
	if kind == "meeting_audio" {
		suffix = "_audio"
	}
	return fmt.Sprintf("%s_%s%s%s", ts, title, suffix, ext)
}


