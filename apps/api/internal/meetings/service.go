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
	ID             uuid.UUID  `json:"id"`
	CreatedBy      uuid.UUID  `json:"created_by"`
	Title          string     `json:"title"`
	Description    string     `json:"description,omitempty"`
	ScheduledAt    *time.Time `json:"scheduled_at,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	LiveKitRoomID  string     `json:"livekit_room_id"`
	RecordEnabled  bool       `json:"record_enabled"`
	AutoTranscribe bool       `json:"auto_transcribe"`
	HasExternal    bool       `json:"has_external"`
	CreatedAt      time.Time  `json:"created_at"`
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
	const q = `
		SELECT DISTINCT m.id, m.created_by, m.title, COALESCE(m.description,''),
		       m.scheduled_at, m.started_at, m.ended_at, m.livekit_room_id,
		       m.record_enabled, m.auto_transcribe, m.has_external, m.created_at
		FROM meeting m
		LEFT JOIN participant p ON p.meeting_id = m.id
		WHERE m.created_by = $1 OR p.user_id = $1
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
			&m.RecordEnabled, &m.AutoTranscribe, &m.HasExternal, &m.CreatedAt,
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
// helpers
// ─────────────────────────────────────────────────────────────────────────

func (s *Service) loadMeeting(ctx context.Context, id uuid.UUID) (*Meeting, error) {
	const q = `
		SELECT id, created_by, title, COALESCE(description,''),
		       scheduled_at, started_at, ended_at, livekit_room_id,
		       record_enabled, auto_transcribe, has_external, created_at
		FROM meeting WHERE id = $1
	`
	m := &Meeting{}
	err := s.db.QueryRow(ctx, q, id).Scan(
		&m.ID, &m.CreatedBy, &m.Title, &m.Description,
		&m.ScheduledAt, &m.StartedAt, &m.EndedAt, &m.LiveKitRoomID,
		&m.RecordEnabled, &m.AutoTranscribe, &m.HasExternal, &m.CreatedAt,
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
		       p.livekit_identity, p.role, p.joined_at, p.left_at,
		       COALESCE(u.full_name, u.email, '') AS display_name
		FROM participant p
		LEFT JOIN "user" u ON u.id = p.user_id
		WHERE p.meeting_id = $1
		ORDER BY (p.role = 'host') DESC, p.created_at ASC
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
			&p.Identity, &p.Role, &p.JoinedAt, &p.LeftAt, &p.DisplayName,
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
