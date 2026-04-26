package auth

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SubjectLoader hydrates a Subject from the database, expanding the contextual
// "manager" relation (list of direct reports). Used by the auth middleware.
type SubjectLoader struct {
	pool *pgxpool.Pool
}

func NewSubjectLoader(pool *pgxpool.Pool) *SubjectLoader {
	return &SubjectLoader{pool: pool}
}

// LoadFromClaims fetches the user row, status, role and direct reports.
// Returns ErrUserBlocked / ErrUserDeactivated if the user can no longer log in.
func (l *SubjectLoader) LoadFromClaims(ctx context.Context, c *AccessClaims) (*Subject, error) {
	var (
		status        string
		deletedInBx24 bool
	)
	const userQ = `SELECT status, deleted_in_bx24 FROM "user" WHERE id = $1`
	if err := l.pool.QueryRow(ctx, userQ, c.UserID).Scan(&status, &deletedInBx24); err != nil {
		return nil, fmt.Errorf("load user: %w", err)
	}
	if status == "blocked" {
		return nil, ErrUserBlocked
	}
	if status == "deactivated_in_bitrix" || deletedInBx24 {
		return nil, ErrUserDeactivated
	}

	// Determine role from role_assignment (admin) or default to user.
	role := RoleUser
	const roleQ = `SELECT 1 FROM role_assignment WHERE user_id = $1 AND role = 'admin' LIMIT 1`
	var dummy int
	if err := l.pool.QueryRow(ctx, roleQ, c.UserID).Scan(&dummy); err == nil {
		role = RoleAdmin
	}

	// Direct reports for contextual "manager" role (only direct, ТЗ 2.1).
	const subQ = `SELECT id FROM "user" WHERE supervisor_id = $1 AND status = 'active'`
	rows, err := l.pool.Query(ctx, subQ, c.UserID)
	if err != nil {
		return nil, fmt.Errorf("load supervises: %w", err)
	}
	defer rows.Close()

	var supervises []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan supervises: %w", err)
		}
		supervises = append(supervises, id)
	}

	return &Subject{
		UserID:     c.UserID,
		Email:      c.Email,
		Role:       role,
		Supervises: supervises,
		SessionID:  c.SessionID,
	}, nil
}

// PromoteAdmin grants the admin role. Idempotent. grantedBy may be uuid.Nil
// for bootstrap (TOOLKIT_BOOTSTRAP_ADMINS).
func PromoteAdmin(ctx context.Context, pool *pgxpool.Pool, target, grantedBy uuid.UUID) error {
	var grantedByArg interface{} = grantedBy
	if grantedBy == uuid.Nil {
		grantedByArg = nil
	}
	const q = `
		INSERT INTO role_assignment (user_id, role, granted_by)
		VALUES ($1, 'admin', $2)
		ON CONFLICT (user_id, role) DO NOTHING
	`
	_, err := pool.Exec(ctx, q, target, grantedByArg)
	return err
}

// DemoteAdmin revokes the admin role. Refuses to demote the last active admin
// (returns ErrLastAdmin). Caller is responsible for audit-log entry.
func DemoteAdmin(ctx context.Context, pool *pgxpool.Pool, target uuid.UUID) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lock admins table to prevent races (two simultaneous demotes).
	const countQ = `
		SELECT COUNT(*) FROM role_assignment ra
		JOIN "user" u ON u.id = ra.user_id
		WHERE ra.role = 'admin' AND u.status = 'active'
		FOR UPDATE
	`
	var count int
	if err := tx.QueryRow(ctx, countQ).Scan(&count); err != nil {
		return fmt.Errorf("count admins: %w", err)
	}
	if count <= 1 {
		return ErrLastAdmin
	}
	if _, err := tx.Exec(ctx, `DELETE FROM role_assignment WHERE user_id = $1 AND role = 'admin'`, target); err != nil {
		return fmt.Errorf("delete admin: %w", err)
	}
	return tx.Commit(ctx)
}
