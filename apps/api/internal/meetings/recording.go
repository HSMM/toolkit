package meetings

// Recording-логика встречи: параллельно стартуем ДВА composite-egress'а:
//     • видео+аудио (MP4) → meeting.current_egress_id        — для просмотра
//     • только аудио (OGG/Opus) → meeting.current_audio_egress_id — для GigaAM
// host жмёт Start → оба egress; recording_active=true.
// host жмёт Stop  → StopEgress на оба; recording_active=false.
// egress_ended webhook идёт по каждому отдельно: распознаём по тому, в какой
// из двух колонок meeting лежит этот egress_id, и создаём recording-row
// нужного типа (meeting_composite | meeting_audio). Транскрипцию ставим
// в очередь только для аудио-дорожки.

import (
	"archive/zip"
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
	// Per-participant audio recording (отдельный OGG на каждого спикера).
	// LiveKit подставляет {participant_identity} в шаблон.
	ParticipantAudioFilepathTmpl string // "meetings/{room_name}/{participant_identity}-{time}.ogg"
}

func (s *Service) AttachRecording(deps RecordingDeps) {
	if deps.VideoFilepathTmpl == "" {
		deps.VideoFilepathTmpl = "meetings/{room_name}/{time}.mp4"
	}
	if deps.AudioFilepathTmpl == "" {
		deps.AudioFilepathTmpl = "meetings/{room_name}/{time}.ogg"
	}
	if deps.ParticipantAudioFilepathTmpl == "" {
		// MP4 контейнер с AAC внутри (см. livekit/client.go
		// StartParticipantAudioEgress). .m4a — это alias для MP4 audio-only,
		// проигрыватели его понимают.
		deps.ParticipantAudioFilepathTmpl = "meetings/{room_name}/per-track/{participant_identity}-{time}.m4a"
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

	// Эксклюзивный lock на meeting на всю проверку+запуск+UPDATE: защита от
	// двойного auto-start (host входит дважды быстрым реджойном) — иначе
	// получим два LK-egress'а, второй перезапишет колонку и первый «утечёт».
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var (
		active           bool
		videoEg, audioEg *string
	)
	if err := tx.QueryRow(ctx, `
		SELECT recording_active, current_egress_id, current_audio_egress_id
		FROM meeting WHERE id=$1 FOR UPDATE
	`, meetingID).Scan(&active, &videoEg, &audioEg); err != nil {
		return err
	}
	if active && videoEg != nil && *videoEg != "" {
		return nil // уже идёт
	}

	// Запускаем обе дорожки. Если вторая упала — первую нужно остановить,
	// чтобы не остался «зависший» видео-egress.
	videoID, err := s.lk.StartRoomCompositeEgress(ctx, m.LiveKitRoomID, "grid", s.recDeps.VideoFilepathTmpl, s.recDeps.S3)
	if err != nil {
		return fmt.Errorf("video egress: %w", err)
	}
	audioID, err := s.lk.StartRoomCompositeAudioEgress(ctx, m.LiveKitRoomID, s.recDeps.AudioFilepathTmpl, s.recDeps.S3)
	if err != nil {
		_ = s.lk.StopEgress(ctx, videoID)
		return fmt.Errorf("audio egress: %w", err)
	}

	if _, err := tx.Exec(ctx, `
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
	if err := tx.Commit(ctx); err != nil {
		_ = s.lk.StopEgress(ctx, videoID)
		_ = s.lk.StopEgress(ctx, audioID)
		return fmt.Errorf("commit: %w", err)
	}

	// После того как composite-recording стартовал — запускаем per-participant
	// audio egress для каждого УЖЕ присутствующего участника. Новые участники
	// будут подхвачены в Join (см. StartParticipantAudioIfActive).
	go s.startAllParticipantEgresses(context.Background(), m.LiveKitRoomID, meetingID)

	return nil
}

// startAllParticipantEgresses — итеративно поднимает per-participant audio
// egress для всех активных (left_at IS NULL) участников встречи.
// Best-effort: ошибка отдельного egress'а логируется, но не валит остальные.
func (s *Service) startAllParticipantEgresses(ctx context.Context, roomID string, meetingID uuid.UUID) {
	if s.recDeps == nil {
		return
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, livekit_identity FROM participant
		WHERE meeting_id = $1 AND left_at IS NULL
		  AND (current_egress_id IS NULL OR current_egress_id = '')
	`, meetingID)
	if err != nil {
		s.logf("startAllParticipantEgresses query: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var pid uuid.UUID
		var ident string
		if err := rows.Scan(&pid, &ident); err != nil {
			continue
		}
		if err := s.startParticipantAudioEgress(ctx, roomID, meetingID, pid, ident); err != nil {
			s.logf("startParticipantAudioEgress %s: %v", ident, err)
		}
	}
}

// startParticipantAudioEgress — создаёт ParticipantEgress audio-only для
// конкретного участника и сохраняет egress_id в participant.current_egress_id.
// Идемпотентно: если у participant уже current_egress_id — выходит.
func (s *Service) startParticipantAudioEgress(ctx context.Context, roomID string, meetingID, participantID uuid.UUID, identity string) error {
	if s.recDeps == nil {
		return nil
	}
	// Проверка через row-lock — защита от двойного старта.
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var cur *string
	if err := tx.QueryRow(ctx, `
		SELECT current_egress_id FROM participant WHERE id = $1 FOR UPDATE
	`, participantID).Scan(&cur); err != nil {
		return err
	}
	if cur != nil && *cur != "" {
		return nil // уже запущен
	}
	egID, err := s.lk.StartParticipantAudioEgress(ctx, roomID, identity, s.recDeps.ParticipantAudioFilepathTmpl, s.recDeps.S3)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE participant SET current_egress_id=$2 WHERE id=$1`, participantID, egID); err != nil {
		_ = s.lk.StopEgress(ctx, egID)
		return err
	}
	return tx.Commit(ctx)
}

// StartParticipantAudioIfActive — вызывается из Join после upsert participant.
// Если recording_active=true, поднимает per-participant audio egress для нового
// участника. Best-effort: ошибки только логируются.
func (s *Service) StartParticipantAudioIfActive(ctx context.Context, meetingID, participantID uuid.UUID, roomID, identity string) {
	if s.recDeps == nil {
		return
	}
	var active bool
	if err := s.db.QueryRow(ctx, `SELECT recording_active FROM meeting WHERE id=$1`, meetingID).Scan(&active); err != nil || !active {
		return
	}
	if err := s.startParticipantAudioEgress(ctx, roomID, meetingID, participantID, identity); err != nil {
		s.logf("StartParticipantAudioIfActive %s: %v", identity, err)
	}
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

	// Останавливаем все per-participant audio egress'ы. egress_ended webhook
	// каждого участника создаст recording row с kind='meeting_per_track'.
	rows, err := s.db.Query(ctx, `
		SELECT current_egress_id FROM participant
		WHERE meeting_id = $1 AND current_egress_id IS NOT NULL AND current_egress_id <> ''
	`, meetingID)
	if err == nil {
		for rows.Next() {
			var pegID string
			if err := rows.Scan(&pegID); err != nil { continue }
			if err := s.lk.StopEgress(ctx, pegID); err != nil {
				s.logf("stop participant egress %s: %v", pegID, err)
			}
		}
		rows.Close()
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

	var fr *livekit.FileResult
	if len(info.FileResults) > 0 {
		fr = info.FileResults[0]
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Эксклюзивный lock на meeting на всю транзакцию — защита от гонки между
	// параллельными webhook'ами видео+аудио и от ретраев одного и того же.
	// COALESCE — после ENDED первой дорожки соответствующая колонка уже NULL.
	const findQ = `
		SELECT id,
		       COALESCE(current_egress_id       = $1, FALSE) AS is_video,
		       COALESCE(current_audio_egress_id = $1, FALSE) AS is_audio
		FROM meeting
		WHERE current_egress_id = $1 OR current_audio_egress_id = $1
		FOR UPDATE
	`
	var (
		meetingID        uuid.UUID
		isVideo, isAudio bool
		isPerTrack       bool
		participantID    uuid.UUID
	)
	err = tx.QueryRow(ctx, findQ, info.EgressID).Scan(&meetingID, &isVideo, &isAudio)
	if errors.Is(err, pgx.ErrNoRows) {
		// Проверяем, не per-participant ли это egress.
		const findPart = `
			SELECT id, meeting_id FROM participant
			WHERE current_egress_id = $1 FOR UPDATE
		`
		if err := tx.QueryRow(ctx, findPart, info.EgressID).Scan(&participantID, &meetingID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				s.logf("OnEgressEnded: no row for egress %s (already cleared, retry?)", info.EgressID)
				return nil
			}
			return err
		}
		isPerTrack = true
	} else if err != nil {
		return err
	}

	// Сбрасываем pointer на эту дорожку. Для per-participant — обнуляем
	// participant.current_egress_id; для room-wide — meeting.current_*.
	if isPerTrack {
		if _, err := tx.Exec(ctx, `UPDATE participant SET current_egress_id = NULL WHERE id = $1`, participantID); err != nil {
			return err
		}
	} else {
		const clearQ = `
			UPDATE meeting
			   SET current_egress_id       = CASE WHEN $2 THEN NULL ELSE current_egress_id END,
			       current_audio_egress_id = CASE WHEN $3 THEN NULL ELSE current_audio_egress_id END,
			       recording_active        = CASE
			           WHEN ($2 OR current_egress_id       IS NULL)
			            AND ($3 OR current_audio_egress_id IS NULL)
			           THEN FALSE ELSE recording_active END
			 WHERE id = $1
		`
		if _, err := tx.Exec(ctx, clearQ, meetingID, isVideo, isAudio); err != nil {
			return err
		}
	}

	// Без этого guard LiveKit для прерванного egress'а (например пользователь
	// нажал «Стоп» до того как Chrome успел подняться) присылает webhook с
	// заполненным template-filename но size=0; мы вставляли row, UI показывал
	// «скачать», запрос падал с 500 в http.ServeContent.
	var size int64
	if fr != nil {
		size = fr.SizeBytes()
	}
	if info.Status != "EGRESS_COMPLETE" || fr == nil || fr.Filename == "" || size == 0 {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		s.logf("egress %s skipped (status=%s, error=%q, size=%d)",
			info.EgressID, info.Status, info.Error, size)
		return nil
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
	switch {
	case isVideo:
		kind, mime, retentionKind = "meeting_composite", "video/mp4", "meeting_composite"
	case isAudio:
		kind, mime, retentionKind = "meeting_audio", "audio/ogg", "meeting_audio"
	default: // per-track participant audio
		kind, mime, retentionKind = "meeting_per_track", "audio/mp4", "meeting_per_track"
	}

	// Для per-track ставим participant_id; для room-wide — NULL.
	var partRef *uuid.UUID
	if isPerTrack {
		partRef = &participantID
	}

	const insRec = `
		INSERT INTO recording
		    (kind, meeting_id, participant_id, s3_bucket, s3_key, mime_type,
		     size_bytes, duration_ms, is_stereo, retention_until)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE,
		        NOW() + (COALESCE((SELECT default_days FROM retention_policy WHERE kind = $9), 30) || ' days')::interval)
		ON CONFLICT (s3_bucket, s3_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
		RETURNING id
	`
	var recordingID uuid.UUID
	if err := tx.QueryRow(ctx, insRec, kind, meetingID, partRef, bucket, key, mime, sizeBytes, durationMs, retentionKind).Scan(&recordingID); err != nil {
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
		// ON CONFLICT по уникальному partial-индексу transcript_recording_active_uniq
		// (миграция 000013). Защищает от ретрая webhook'а — повторный INSERT
		// обновит engine_metadata, но НЕ создаст вторую расшифровку и не пошлёт
		// дубль в очередь.
		const insTx = `
			INSERT INTO transcript (recording_id, status, engine, engine_metadata, retention_until)
			SELECT $1, 'queued', 'gigaam', $2, r.retention_until + interval '30 days'
			  FROM recording r WHERE r.id = $1
			ON CONFLICT (recording_id) WHERE status IN ('queued','processing','completed','partial')
			DO UPDATE SET engine_metadata = EXCLUDED.engine_metadata
			RETURNING id, (xmax = 0) AS inserted
		`
		var inserted bool
		if err := tx.QueryRow(ctx, insTx, recordingID, rawMeta).Scan(&transcriptID, &inserted); err != nil {
			return fmt.Errorf("insert transcript: %w", err)
		}
		// Job ставим только когда реально создали новую транскрипцию (а не
		// обновили существующую от ретрая webhook'а), иначе дубль обработки.
		if inserted {
			payload, _ := json.Marshal(map[string]any{
				"transcript_id": transcriptID,
				"recording_id":  recordingID,
			})
			if _, err := tx.Exec(ctx, `
				INSERT INTO job (kind, payload, scheduled_at, max_attempts, priority)
				VALUES ('transcribe_recording', $1, NOW(), 5, 50)
			`, payload); err != nil {
				return fmt.Errorf("enqueue transcribe: %w", err)
			}
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
	if s.log == nil {
		return
	}
	s.log.Info(fmt.Sprintf(format, args...))
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

// StreamPerTrackArchive — стримит ZIP-архив со всеми meeting_per_track
// recording'ами встречи. Внутри zip — `<participant>-<timestamp>.ogg`,
// где <participant> = full_name пользователя (если был залогинен) или
// внешнее имя гостя.
func (s *Service) StreamPerTrackArchive(ctx context.Context, subj *auth.Subject, w http.ResponseWriter, _ *http.Request, meetingID uuid.UUID) error {
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

	type row struct {
		s3Key     string
		createdAt time.Time
		fullName  string
		extName   string
		identity  string
	}
	const q = `
		SELECT r.s3_key, r.created_at,
		       COALESCE(u.full_name, ''), COALESCE(p.external_name, ''),
		       COALESCE(p.livekit_identity, '')
		FROM recording r
		LEFT JOIN participant p ON p.id = r.participant_id
		LEFT JOIN "user"      u ON u.id = p.user_id
		WHERE r.meeting_id = $1 AND r.kind = 'meeting_per_track'
		ORDER BY r.created_at
	`
	rows, err := s.db.Query(ctx, q, meetingID)
	if err != nil {
		return err
	}
	items := make([]row, 0, 4)
	for rows.Next() {
		var it row
		if err := rows.Scan(&it.s3Key, &it.createdAt, &it.fullName, &it.extName, &it.identity); err != nil {
			rows.Close()
			return err
		}
		items = append(items, it)
	}
	rows.Close()

	zipName := fmt.Sprintf("%s_audio_per_speaker.zip", strings.TrimSuffix(friendlyFilename(m, "meeting_composite", ""), ".mp4"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, zipName))
	if len(items) == 0 {
		// Пустой zip — UI отобразит «пусто».
		zw := zip.NewWriter(w)
		_ = zw.Close()
		return nil
	}

	zw := zip.NewWriter(w)
	defer zw.Close()
	used := map[string]int{}
	for _, it := range items {
		who := pickSpeakerName(it.fullName, it.extName, it.identity)
		base := sanitizeFilename(who) + "_" + it.createdAt.Format("150405")
		// Расширение берём от реального S3-объекта (.m4a / .ogg / ...).
		ext := strings.ToLower(path.Ext(it.s3Key))
		if ext == "" {
			ext = ".m4a"
		}
		// Если несколько файлов от одного спикера в одну секунду — добавим суффикс.
		used[base]++
		name := base + ext
		if used[base] > 1 {
			name = fmt.Sprintf("%s_%d%s", base, used[base], ext)
		}

		fw, err := zw.Create(name)
		if err != nil {
			return err
		}
		rc, err := s.recDeps.Storage.GetRecording(ctx, it.s3Key)
		if err != nil {
			s.logf("zip skip %s: %v", it.s3Key, err)
			continue
		}
		_, err = io.Copy(fw, rc)
		_ = rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func pickSpeakerName(fullName, extName, identity string) string {
	if fullName != "" {
		return fullName
	}
	if extName != "" {
		return "guest_" + extName
	}
	if identity != "" {
		return identity
	}
	return "speaker"
}

func sanitizeFilename(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "speaker"
	}
	out := strings.Map(func(r rune) rune {
		switch {
		case r == ' ' || r == '-' || r == '_':
			return '_'
		case r >= '0' && r <= '9':
			return r
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r
		case r >= 'А' && r <= 'я':
			return r
		case r == 'Ё' || r == 'ё':
			return r
		default:
			return '_'
		}
	}, s)
	if len(out) > 60 {
		out = out[:60]
	}
	return out
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


