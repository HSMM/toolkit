// Package meetings — модуль ВКС (E5): создание/список/просмотр встречи,
// выпуск LiveKit-токенов на join, фиксация participant-входов/выходов,
// принудительное завершение комнаты.
//
// MVP scope (E5.1): только сотрудники (без гостей по email-ссылкам), без
// записи через Egress (E5.2 добавит). Каждая встреча в LiveKit живёт пока
// есть участники (auto-create при первом join, auto-delete по empty_timeout
// из livekit.yaml). Принудительный End — Twirp DeleteRoom.
package meetings

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/HSMM/toolkit/internal/auth"
	"github.com/HSMM/toolkit/internal/livekit"
)

// Service — фасад над БД и LiveKit-клиентом.
type Service struct {
	db *pgxpool.Pool
	lk *livekit.Client
	// publicWS — wss://… для браузера (передаётся клиенту).
	publicWS string
	// recDeps — настроены в server.go через AttachRecording (E5.2). Если nil,
	// все методы записи возвращают ErrRecordingNotConfigured.
	recDeps *RecordingDeps
}

func New(db *pgxpool.Pool, lk *livekit.Client, publicWS string) *Service {
	return &Service{db: db, lk: lk, publicWS: publicWS}
}

// PublicWS возвращает URL, который фронт должен передать в LiveKitRoom.
func (s *Service) PublicWS() string { return s.publicWS }

// CreateInput — параметры создания встречи.
type CreateInput struct {
	CreatorID       uuid.UUID
	Title           string
	Description     string
	ScheduledAt     *time.Time // nil → instant
	RecordEnabled   bool
	AutoTranscribe  bool
	ParticipantIDs  []uuid.UUID // приглашённые сотрудники (могут быть пусты)
}

type Meeting struct {
	ID                  uuid.UUID  `json:"id"`
	CreatedBy           uuid.UUID  `json:"created_by"`
	Title               string     `json:"title"`
	Description         string     `json:"description,omitempty"`
	ScheduledAt         *time.Time `json:"scheduled_at,omitempty"`
	StartedAt           *time.Time `json:"started_at,omitempty"`
	EndedAt             *time.Time `json:"ended_at,omitempty"`
	LiveKitRoomID       string     `json:"livekit_room_id"`
	RecordEnabled       bool       `json:"record_enabled"`
	AutoTranscribe      bool       `json:"auto_transcribe"`
	HasExternal         bool       `json:"has_external"`
	RecordingActive     bool       `json:"recording_active"`
	RecordingStartedAt  *time.Time `json:"recording_started_at,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
}

type Participant struct {
	ID             uuid.UUID  `json:"id"`
	MeetingID      uuid.UUID  `json:"meeting_id"`
	UserID         *uuid.UUID `json:"user_id,omitempty"`
	IsGuest        bool       `json:"is_guest"`
	ExternalName   string     `json:"external_name,omitempty"`
	ExternalEmail  string     `json:"external_email,omitempty"`
	Identity       string     `json:"livekit_identity"`
	Role           string     `json:"role"`
	AdmitState     string     `json:"admit_state"` // "pending" | "admitted" | "rejected"
	JoinedAt       *time.Time `json:"joined_at,omitempty"`
	LeftAt         *time.Time `json:"left_at,omitempty"`
	// Заполняется при join: фактическое имя сотрудника (для UI).
	DisplayName    string     `json:"display_name,omitempty"`
}

// Create записывает встречу в БД (instant — started_at=NOW(); scheduled — без started_at).
// Создатель автоматически добавляется participant'ом с ролью host.
func (s *Service) Create(ctx context.Context, in CreateInput) (*Meeting, error) {
	if in.Title = strings.TrimSpace(in.Title); in.Title == "" {
		return nil, errors.New("title required")
	}
	roomID := newRoomID()

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var (
		startedAt *time.Time
		now       = time.Now()
	)
	if in.ScheduledAt == nil {
		startedAt = &now
	}

	m := &Meeting{
		CreatedBy:      in.CreatorID,
		Title:          in.Title,
		Description:    in.Description,
		ScheduledAt:    in.ScheduledAt,
		StartedAt:      startedAt,
		LiveKitRoomID:  roomID,
		RecordEnabled:  in.RecordEnabled,
		AutoTranscribe: in.AutoTranscribe,
	}

	const q = `
		INSERT INTO meeting (created_by, title, description, scheduled_at, started_at,
		                     livekit_room_id, record_enabled, auto_transcribe)
		VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, $5, $6, $7, $8)
		RETURNING id, created_at
	`
	if err := tx.QueryRow(ctx, q,
		in.CreatorID, in.Title, in.Description, in.ScheduledAt, startedAt,
		roomID, in.RecordEnabled, in.AutoTranscribe,
	).Scan(&m.ID, &m.CreatedAt); err != nil {
		return nil, fmt.Errorf("insert meeting: %w", err)
	}

	// Создатель сразу как host-participant (без joined_at — это произойдёт при первом /join).
	if err := insertParticipant(ctx, tx, m.ID, in.CreatorID, "host"); err != nil {
		return nil, err
	}
	for _, uid := range dedupUUIDs(in.ParticipantIDs, in.CreatorID) {
		if err := insertParticipant(ctx, tx, m.ID, uid, "participant"); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return m, nil
}

// List возвращает встречи, в которых пользователь — создатель или приглашённый.
// Сортировка: активные сверху, дальше по started_at/scheduled_at DESC.
func (s *Service) List(ctx context.Context, userID uuid.UUID, limit int) ([]*Meeting, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// EXISTS вместо DISTINCT+JOIN: иначе PG ругается на ORDER BY с выражениями,
	// которых нет дословно в select-list.
	const q = `
		SELECT m.id, m.created_by, m.title, COALESCE(m.description,''),
		       m.scheduled_at, m.started_at, m.ended_at, m.livekit_room_id,
		       m.record_enabled, m.auto_transcribe, m.has_external,
		       m.recording_active, m.recording_started_at, m.created_at
		FROM meeting m
		WHERE m.created_by = $1
		   OR EXISTS (SELECT 1 FROM participant p WHERE p.meeting_id = m.id AND p.user_id = $1)
		ORDER BY (m.ended_at IS NULL) DESC,
		         COALESCE(m.started_at, m.scheduled_at, m.created_at) DESC
		LIMIT $2
	`
	rows, err := s.db.Query(ctx, q, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]*Meeting, 0, 16)
	for rows.Next() {
		m := &Meeting{}
		if err := rows.Scan(&m.ID, &m.CreatedBy, &m.Title, &m.Description,
			&m.ScheduledAt, &m.StartedAt, &m.EndedAt, &m.LiveKitRoomID,
			&m.RecordEnabled, &m.AutoTranscribe, &m.HasExternal,
			&m.RecordingActive, &m.RecordingStartedAt, &m.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Get возвращает встречу с participants. Доступ: создатель, любой participant, admin.
func (s *Service) Get(ctx context.Context, subj *auth.Subject, id uuid.UUID) (*Meeting, []*Participant, error) {
	m, err := s.loadMeeting(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	parts, err := s.loadParticipants(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if !canViewMeeting(subj, m, parts) {
		return nil, nil, ErrForbidden
	}
	return m, parts, nil
}

// JoinResult — то, что фронт получает на /join.
type JoinResult struct {
	Token    string `json:"token"`
	WSURL    string `json:"ws_url"`
	Room     string `json:"room"`
	Identity string `json:"identity"`
	Role     string `json:"role"`
}

// Join выпускает LiveKit-токен для текущего пользователя. Если юзер не был
// в participant — добавляет (роль participant). Проставляет joined_at и
// (для instant-встреч, у которых уже started_at) ничего не меняет; для
// запланированных, у которых ещё не было первого входа — выставляет started_at.
func (s *Service) Join(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) (*JoinResult, error) {
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return nil, err
	}
	if m.EndedAt != nil {
		return nil, ErrEnded
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Стартуем встречу если ещё не запущена.
	if m.StartedAt == nil {
		now := time.Now()
		if _, err := tx.Exec(ctx, `UPDATE meeting SET started_at = $2 WHERE id = $1 AND started_at IS NULL`, m.ID, now); err != nil {
			return nil, fmt.Errorf("set started_at: %w", err)
		}
		m.StartedAt = &now
	}

	identity := userIdentity(subj.UserID)
	displayName := subj.Email // лучше full_name, но Subject его не содержит — фронт сам шлёт
	role := "participant"
	if subj.UserID == m.CreatedBy {
		role = "host"
	}

	// Upsert participant. participant_livekit_identity_uniq (meeting_id, identity).
	const upsert = `
		INSERT INTO participant (meeting_id, user_id, livekit_identity, role, joined_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (meeting_id, livekit_identity) DO UPDATE
		   SET joined_at = COALESCE(participant.joined_at, EXCLUDED.joined_at),
		       left_at   = NULL,
		       role      = participant.role
		RETURNING role
	`
	if err := tx.QueryRow(ctx, upsert, m.ID, subj.UserID, identity, role).Scan(&role); err != nil {
		return nil, fmt.Errorf("upsert participant: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	tok, err := s.lk.MintJoinToken(livekit.JoinTokenOptions{
		Room:     m.LiveKitRoomID,
		Identity: identity,
		Name:     displayName,
		CanPub:   true,
		CanSub:   true,
		CanData:  true,
		Admin:    role == "host" || subj.Role == auth.RoleAdmin,
	})
	if err != nil {
		return nil, fmt.Errorf("mint token: %w", err)
	}

	// Если host входит в комнату с record_enabled=true и запись ещё не идёт —
	// автоматически стартуем (best-effort, асинхронно, чтобы не задержать join).
	// Сама StartRecording идемпотентна: повторный вызов на active recording
	// вернёт nil без побочек.
	if role == "host" && m.RecordEnabled && !m.RecordingActive && s.recDeps != nil {
		subjCopy := subj
		mID := m.ID
		go func() {
			if err := s.StartRecording(context.Background(), subjCopy, mID); err != nil {
				s.logf("auto-start recording on host join: %v", err)
			}
		}()
	}

	return &JoinResult{
		Token:    tok,
		WSURL:    s.publicWS,
		Room:     m.LiveKitRoomID,
		Identity: identity,
		Role:     role,
	}, nil
}

// Leave проставляет left_at для participant текущего пользователя (best-effort).
func (s *Service) Leave(ctx context.Context, userID, meetingID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE participant SET left_at = NOW()
		 WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
	`, meetingID, userID)
	return err
}

// End — host или admin принудительно завершает: ended_at + Twirp DeleteRoom.
func (s *Service) End(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) error {
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return err
	}
	if !(subj.Role == auth.RoleAdmin || subj.UserID == m.CreatedBy) {
		return ErrForbidden
	}
	if m.EndedAt != nil {
		return nil
	}
	if _, err := s.db.Exec(ctx, `UPDATE meeting SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`, meetingID); err != nil {
		return fmt.Errorf("set ended_at: %w", err)
	}
	// LiveKit DeleteRoom — best-effort: если комната уже пустая (auto-deleted),
	// получим OK; если LiveKit недоступен — лог, БД уже обновлена.
	if err := s.lk.EndRoom(ctx, m.LiveKitRoomID); err != nil {
		return fmt.Errorf("livekit end: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────
// guest access (E5.3): публичная ссылка для подключения без сессии Toolkit
// ─────────────────────────────────────────────────────────────────────────

// GuestMeetingInfo — публичный срез данных встречи для landing-страницы гостя.
type GuestMeetingInfo struct {
	MeetingID    uuid.UUID  `json:"meeting_id"`
	Title        string     `json:"title"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	ScheduledAt  *time.Time `json:"scheduled_at,omitempty"`
	HostName     string     `json:"host_name,omitempty"`
}

// EnsureGuestLink — host или admin: возвращает текущий guest_link_token
// (или генерирует новый, если null). Token — URL-safe ~32 символа, не секретен
// для админов, но является единственным секретом для входа гостя.
func (s *Service) EnsureGuestLink(ctx context.Context, subj *auth.Subject, meetingID uuid.UUID) (string, error) {
	m, err := s.loadMeeting(ctx, meetingID)
	if err != nil {
		return "", err
	}
	if !(subj.Role == auth.RoleAdmin || subj.UserID == m.CreatedBy) {
		return "", ErrForbidden
	}
	if m.EndedAt != nil {
		return "", ErrEnded
	}

	var existing *string
	if err := s.db.QueryRow(ctx, `SELECT guest_link_token FROM meeting WHERE id = $1`, meetingID).Scan(&existing); err != nil {
		return "", err
	}
	if existing != nil && *existing != "" {
		return *existing, nil
	}
	tok, err := randomURLToken(24) // ~32 символа base64url
	if err != nil {
		return "", err
	}
	if _, err := s.db.Exec(ctx, `UPDATE meeting SET guest_link_token = $2 WHERE id = $1`, meetingID, tok); err != nil {
		return "", fmt.Errorf("set guest_link_token: %w", err)
	}
	return tok, nil
}

// GuestLookup — публичный (no auth): по token возвращает мини-инфо встречи
// для отображения landing-страницы (название, host). Возвращает ErrNotFound
// если token не найден или встреча уже завершена.
func (s *Service) GuestLookup(ctx context.Context, token string) (*GuestMeetingInfo, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	const q = `
		SELECT m.id, m.title, m.started_at, m.scheduled_at, m.ended_at,
		       COALESCE(u.full_name, u.email, '')
		FROM meeting m
		LEFT JOIN "user" u ON u.id = m.created_by
		WHERE m.guest_link_token = $1
	`
	var (
		id          uuid.UUID
		title       string
		startedAt   *time.Time
		scheduledAt *time.Time
		endedAt     *time.Time
		hostName    string
	)
	err := s.db.QueryRow(ctx, q, token).Scan(&id, &title, &startedAt, &scheduledAt, &endedAt, &hostName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if endedAt != nil {
		return nil, ErrEnded
	}
	return &GuestMeetingInfo{
		MeetingID:   id,
		Title:       title,
		StartedAt:   startedAt,
		ScheduledAt: scheduledAt,
		HostName:    hostName,
	}, nil
}

// GuestRequestEntry — публичный (no auth): создаёт pending-participant и
// возвращает request_id, по которому гость потом поллит статус. Сама встреча
// при этом НЕ стартует (started_at выставится только когда host реально
// допустит первого участника, либо когда host сам зайдёт).
func (s *Service) GuestRequestEntry(ctx context.Context, token, displayName string) (uuid.UUID, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = "Гость"
	}
	if len(displayName) > 80 {
		displayName = displayName[:80]
	}

	info, err := s.GuestLookup(ctx, token)
	if err != nil {
		return uuid.Nil, err
	}

	identity := "g_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	tokHash := sha256.Sum256([]byte(token))

	var requestID uuid.UUID
	const q = `
		INSERT INTO participant
		    (meeting_id, is_guest, external_name, guest_token_hash, livekit_identity, role, admit_state)
		VALUES ($1, TRUE, $2, $3, $4, 'guest', 'pending')
		RETURNING id
	`
	if err := s.db.QueryRow(ctx, q,
		info.MeetingID, displayName, hex.EncodeToString(tokHash[:]), identity,
	).Scan(&requestID); err != nil {
		return uuid.Nil, fmt.Errorf("insert guest request: %w", err)
	}
	return requestID, nil
}

// GuestPollStatus — публичный (no auth): возвращает текущий статус заявки гостя.
// Если admitted — также выпускает LiveKit-токен (одноразово на каждый poll —
// LK сам ОК с этим). Если pending — клиент продолжает поллить. Если rejected
// или встреча завершена — возвращает соответствующий state, токена не будет.
type GuestStatus struct {
	State string      `json:"state"`              // "pending" | "admitted" | "rejected" | "ended"
	Join  *JoinResult `json:"join,omitempty"`     // present iff state=admitted
}

func (s *Service) GuestPollStatus(ctx context.Context, token string, requestID uuid.UUID) (*GuestStatus, error) {
	// Сверяем token + requestID, чтобы posting random uuid'ов из чужих ссылок
	// не работало.
	tokHash := sha256.Sum256([]byte(token))
	const q = `
		SELECT p.admit_state, p.external_name, p.livekit_identity,
		       m.id, m.livekit_room_id, m.ended_at
		FROM participant p
		JOIN meeting m ON m.id = p.meeting_id
		WHERE p.id = $1 AND p.guest_token_hash = $2
	`
	var (
		state, extName, identity, roomID string
		meetingID                        uuid.UUID
		endedAt                          *time.Time
	)
	err := s.db.QueryRow(ctx, q, requestID, hex.EncodeToString(tokHash[:])).Scan(
		&state, &extName, &identity, &meetingID, &roomID, &endedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if endedAt != nil {
		return &GuestStatus{State: "ended"}, nil
	}
	switch state {
	case "rejected":
		return &GuestStatus{State: "rejected"}, nil
	case "pending":
		return &GuestStatus{State: "pending"}, nil
	case "admitted":
		lkTok, err := s.lk.MintJoinToken(livekit.JoinTokenOptions{
			Room: roomID, Identity: identity, Name: extName,
			CanPub: true, CanSub: true, CanData: true,
		})
		if err != nil {
			return nil, fmt.Errorf("mint guest token: %w", err)
		}
		return &GuestStatus{
			State: "admitted",
			Join:  &JoinResult{Token: lkTok, WSURL: s.publicWS, Room: roomID, Identity: identity, Role: "guest"},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected admit_state: %s", state)
	}
}

// AdmitGuest — host или admin принимает решение по pending-гостю.
// allow=true → admitted (+ joined_at, + помечаем встречу has_external,
// + стартуем started_at если ещё не).
// allow=false → rejected (гость на след. поллинге увидит отказ).
func (s *Service) AdmitGuest(ctx context.Context, subj *auth.Subject, meetingID, participantID uuid.UUID, allow bool) error {
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

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Проверяем что participant принадлежит этой встрече и сейчас pending.
	var curState string
	err = tx.QueryRow(ctx, `SELECT admit_state FROM participant WHERE id = $1 AND meeting_id = $2`, participantID, m.ID).Scan(&curState)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if curState != "pending" {
		// Идемпотентно: уже разрулено.
		return nil
	}

	if allow {
		if _, err := tx.Exec(ctx, `
			UPDATE participant SET admit_state = 'admitted', joined_at = NOW()
			 WHERE id = $1
		`, participantID); err != nil {
			return fmt.Errorf("admit: %w", err)
		}
		if m.StartedAt == nil {
			if _, err := tx.Exec(ctx, `UPDATE meeting SET started_at = NOW() WHERE id = $1 AND started_at IS NULL`, m.ID); err != nil {
				return fmt.Errorf("start meeting on admit: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE meeting SET has_external = TRUE WHERE id = $1 AND has_external = FALSE`, m.ID); err != nil {
			return fmt.Errorf("set has_external: %w", err)
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE participant SET admit_state = 'rejected' WHERE id = $1`, participantID); err != nil {
			return fmt.Errorf("reject: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func randomURLToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

func (s *Service) loadMeeting(ctx context.Context, id uuid.UUID) (*Meeting, error) {
	const q = `
		SELECT id, created_by, title, COALESCE(description,''),
		       scheduled_at, started_at, ended_at, livekit_room_id,
		       record_enabled, auto_transcribe, has_external,
		       recording_active, recording_started_at, created_at
		FROM meeting WHERE id = $1
	`
	m := &Meeting{}
	err := s.db.QueryRow(ctx, q, id).Scan(
		&m.ID, &m.CreatedBy, &m.Title, &m.Description,
		&m.ScheduledAt, &m.StartedAt, &m.EndedAt, &m.LiveKitRoomID,
		&m.RecordEnabled, &m.AutoTranscribe, &m.HasExternal,
		&m.RecordingActive, &m.RecordingStartedAt, &m.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

func (s *Service) loadParticipants(ctx context.Context, meetingID uuid.UUID) ([]*Participant, error) {
	const q = `
		SELECT p.id, p.meeting_id, p.user_id, p.is_guest,
		       COALESCE(p.external_name,''), COALESCE(p.external_email,''),
		       p.livekit_identity, p.role, p.admit_state, p.joined_at, p.left_at,
		       COALESCE(u.full_name, u.email, '') AS display_name
		FROM participant p
		LEFT JOIN "user" u ON u.id = p.user_id
		WHERE p.meeting_id = $1
		ORDER BY (p.admit_state = 'pending') DESC, (p.role = 'host') DESC, p.created_at ASC
	`
	rows, err := s.db.Query(ctx, q, meetingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*Participant, 0, 8)
	for rows.Next() {
		p := &Participant{}
		if err := rows.Scan(&p.ID, &p.MeetingID, &p.UserID, &p.IsGuest,
			&p.ExternalName, &p.ExternalEmail,
			&p.Identity, &p.Role, &p.AdmitState, &p.JoinedAt, &p.LeftAt, &p.DisplayName,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func insertParticipant(ctx context.Context, tx pgx.Tx, meetingID, userID uuid.UUID, role string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO participant (meeting_id, user_id, livekit_identity, role)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (meeting_id, livekit_identity) DO NOTHING
	`, meetingID, userID, userIdentity(userID), role)
	return err
}

// canViewMeeting — minimal MVP RBAC: admin, создатель, любой participant.
// E8 заменит на Authz матрицу из ТЗ 4.1.
func canViewMeeting(subj *auth.Subject, m *Meeting, parts []*Participant) bool {
	if subj.Role == auth.RoleAdmin || subj.UserID == m.CreatedBy {
		return true
	}
	for _, p := range parts {
		if p.UserID != nil && *p.UserID == subj.UserID {
			return true
		}
	}
	return false
}

func userIdentity(id uuid.UUID) string { return "u_" + id.String() }

// newRoomID — короткий, URL-safe, без коллизий: "mtg-<uuid8>".
func newRoomID() string {
	id := uuid.NewString() // 36 chars
	return "mtg-" + strings.ReplaceAll(id[:8], "-", "")
}

func dedupUUIDs(ids []uuid.UUID, exclude uuid.UUID) []uuid.UUID {
	if len(ids) == 0 {
		return nil
	}
	seen := map[uuid.UUID]struct{}{exclude: {}}
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
