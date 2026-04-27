package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Action describes what the subject is trying to do, for audit-log labelling
// and for picking the right authz path.
type Action string

const (
	ActionView           Action = "view"             // see metadata in lists
	ActionListen         Action = "listen"           // play recording
	ActionRead           Action = "read"             // read transcript
	ActionExport         Action = "export"           // export transcript file
	ActionEdit           Action = "edit"             // edit transcript segment
	ActionRollback       Action = "rollback"         // revert transcript edit
	ActionRetentionHold  Action = "retention_hold"   // freeze retention
	ActionEarlyDelete    Action = "early_delete"     // delete before retention
	ActionGDPRExecute    Action = "gdpr_execute"     // 152-ФЗ deletion
)

// Decision describes the outcome of an authorization check.
type Decision struct {
	Allowed         bool
	RequiresReason  bool   // UI must collect text justification
	NotifyOwner     bool   // email owner about access
	AuditNote       string // pre-filled audit_log details
}

// Allow returns Decision{Allowed: true, ...}.
func Allow(opts ...func(*Decision)) Decision {
	d := Decision{Allowed: true}
	for _, o := range opts {
		o(&d)
	}
	return d
}

// Deny returns Decision{Allowed: false}.
func Deny() Decision { return Decision{} }

// WithReason marks the decision as requiring justification.
func WithReason() func(*Decision) { return func(d *Decision) { d.RequiresReason = true } }

// WithNotify marks the decision as triggering owner notification.
func WithNotify() func(*Decision) { return func(d *Decision) { d.NotifyOwner = true } }

// Authz checks fine-grained access to recordings/transcripts/meetings.
// Implements the matrix in spec
type Authz struct {
	pool *pgxpool.Pool
}

func NewAuthz(pool *pgxpool.Pool) *Authz {
	return &Authz{pool: pool}
}

// CheckRecording decides whether subject may perform action on the recording.
//
// Rules (subset of ТЗ 4.1):
//   - admin → with reason+audit (except retention_hold/early_delete which are
//     admin-only and require only audit, not reason).
//   - participant of the call/meeting → allowed without reason.
//   - direct supervisor of a participant → with reason+audit+notify.
//   - everybody else → deny.
func (a *Authz) CheckRecording(ctx context.Context, s *Subject, recordingID uuid.UUID, action Action) (Decision, error) {
	if s == nil {
		return Deny(), ErrUnauthenticated
	}

	// Admin-only actions.
	switch action {
	case ActionRetentionHold, ActionEarlyDelete, ActionGDPRExecute:
		if s.IsAdmin() {
			return Allow(), nil
		}
		return Deny(), nil
	}

	// Resolve participants of this recording (call sides, meeting members).
	participants, err := a.recordingParticipants(ctx, recordingID)
	if err != nil {
		return Deny(), err
	}

	// Owner / participant → free access (own data).
	for _, p := range participants {
		if p == s.UserID {
			return Allow(), nil
		}
	}

	// Admin (non-restricted action) → with reason + audit.
	if s.IsAdmin() {
		return Allow(WithReason()), nil
	}

	// Direct supervisor of any participant → with reason + audit + notify.
	for _, p := range participants {
		if s.SupervisesUser(p) {
			return Allow(WithReason(), WithNotify()), nil
		}
	}

	return Deny(), nil
}

// recordingParticipants returns the user IDs that are "owners" of the recording.
// For a call: from_user_id, to_user_id (those that exist).
// For a meeting (composite or per_track): all participant.user_id of the meeting.
func (a *Authz) recordingParticipants(ctx context.Context, recordingID uuid.UUID) ([]uuid.UUID, error) {
	const q = `
		SELECT r.kind, r.call_id, r.meeting_id
		FROM recording r
		WHERE r.id = $1
	`
	var (
		kind        string
		callID      *uuid.UUID
		meetingID   *uuid.UUID
	)
	if err := a.pool.QueryRow(ctx, q, recordingID).Scan(&kind, &callID, &meetingID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("recording not found")
		}
		return nil, fmt.Errorf("load recording: %w", err)
	}

	switch {
	case callID != nil:
		const cq = `SELECT from_user_id, to_user_id FROM call WHERE id = $1`
		var fromU, toU *uuid.UUID
		if err := a.pool.QueryRow(ctx, cq, *callID).Scan(&fromU, &toU); err != nil {
			return nil, err
		}
		out := []uuid.UUID{}
		if fromU != nil {
			out = append(out, *fromU)
		}
		if toU != nil && (fromU == nil || *toU != *fromU) {
			out = append(out, *toU)
		}
		return out, nil
	case meetingID != nil:
		rows, err := a.pool.Query(ctx,
			`SELECT user_id FROM participant WHERE meeting_id = $1 AND user_id IS NOT NULL`,
			*meetingID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, nil
	}
	return nil, fmt.Errorf("recording %s has no call or meeting linkage", recordingID)
}
