// Package auth implements OAuth2-Bitrix24 SSO, Toolkit JWT sessions,
// session storage, and the RBAC engine used throughout the API.
package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

// Role is a Toolkit role. Only "admin" is materialized in role_assignment;
// "user" is the default for everyone, "manager" is computed contextually
// from the supervisor relationship in "user".supervisor_id.
type Role string

const (
	RoleUser    Role = "user"
	RoleAdmin   Role = "admin"
	RoleManager Role = "manager" // contextual: applies only relative to direct reports
)

// Subject is the authenticated principal carried through request context.
// Built from the JWT access token plus a per-request expansion of contextual
// roles (Supervises) loaded from the user table.
type Subject struct {
	UserID     uuid.UUID
	Email      string
	Role       Role        // user or admin
	Supervises []uuid.UUID // direct reports (for contextual "manager" role)
	SessionID  uuid.UUID
}

// IsAdmin returns true if the subject has the admin role.
func (s *Subject) IsAdmin() bool {
	return s != nil && s.Role == RoleAdmin
}

// SupervisesUser returns true if the subject directly supervises userID.
func (s *Subject) SupervisesUser(userID uuid.UUID) bool {
	if s == nil {
		return false
	}
	for _, id := range s.Supervises {
		if id == userID {
			return true
		}
	}
	return false
}

// IsSelf returns true if the subject is operating on their own resources.
func (s *Subject) IsSelf(userID uuid.UUID) bool {
	return s != nil && s.UserID == userID
}

// ctxKey is unexported to prevent collisions with other packages' context keys.
type ctxKey struct{}

// WithSubject attaches the subject to ctx. Used by the auth middleware after
// JWT validation and supervises expansion.
func WithSubject(ctx context.Context, s *Subject) context.Context {
	return context.WithValue(ctx, ctxKey{}, s)
}

// FromContext returns the subject attached to ctx, or nil if unauthenticated.
func FromContext(ctx context.Context) *Subject {
	s, _ := ctx.Value(ctxKey{}).(*Subject)
	return s
}

// MustSubject returns the subject from ctx or panics. Use in handlers that
// are protected by RequireAuth middleware (where presence is guaranteed).
func MustSubject(ctx context.Context) *Subject {
	s := FromContext(ctx)
	if s == nil {
		panic("auth: subject missing from context (route not protected by RequireAuth?)")
	}
	return s
}

// Common errors returned by auth-related code.
var (
	ErrUnauthenticated  = errors.New("auth: unauthenticated")
	ErrInvalidToken     = errors.New("auth: invalid token")
	ErrExpiredToken     = errors.New("auth: token expired")
	ErrSessionRevoked   = errors.New("auth: session revoked")
	ErrSessionNotFound  = errors.New("auth: session not found")
	ErrUserBlocked      = errors.New("auth: user blocked")
	ErrUserDeactivated  = errors.New("auth: user deactivated in bitrix24")
	ErrLastAdmin        = errors.New("auth: cannot demote the last admin")
	ErrForbidden        = errors.New("auth: forbidden")
	ErrReasonRequired   = errors.New("auth: justification required for this access")
)
