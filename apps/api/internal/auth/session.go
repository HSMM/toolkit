package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefreshTokenBytes is the size of the random token we hand to the browser
// (HttpOnly Secure cookie). 32 bytes → 64 hex chars, sufficient entropy.
const RefreshTokenBytes = 32

// RefreshTokenInactivityTTL — sliding TTL of refresh tokens (per spec).
// Configurable by admin per ТЗ 3.1.
const RefreshTokenInactivityTTL = 30 * 24 * time.Hour

// SessionStore persists refresh tokens, rotates them, revokes them.
// All operations are safe under concurrent calls.
type SessionStore struct {
	pool *pgxpool.Pool
}

func NewSessionStore(pool *pgxpool.Pool) *SessionStore {
	return &SessionStore{pool: pool}
}

// SessionRecord is the in-DB session row, hydrated by Validate.
type SessionRecord struct {
	ID                          uuid.UUID
	UserID                      uuid.UUID
	BitrixRefreshTokenEncrypted string // empty if none stored
	IP                          string
	UserAgent                   string
	CreatedAt                   time.Time
	LastUsedAt                  time.Time
	RevokedAt                   *time.Time
}

// hashToken returns the SHA-256 hash hex of a refresh token. We never store
// tokens in plaintext.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// generateRefreshToken returns a new random token (hex-encoded).
func generateRefreshToken() (string, error) {
	buf := make([]byte, RefreshTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// Create inserts a new session row and returns the plaintext refresh token
// (caller sends this in HttpOnly cookie) and the new session UUID.
func (s *SessionStore) Create(ctx context.Context, userID uuid.UUID, ip, userAgent, bitrixRefreshEncrypted string) (token string, sessionID uuid.UUID, err error) {
	token, err = generateRefreshToken()
	if err != nil {
		return "", uuid.Nil, err
	}
	hash := hashToken(token)
	sessionID = uuid.New()

	const q = `
		INSERT INTO session (id, user_id, refresh_token_hash, bitrix_refresh_token_encrypted, ip, user_agent)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, '')::inet, NULLIF($6, ''))
	`
	if _, err = s.pool.Exec(ctx, q, sessionID, userID, hash, bitrixRefreshEncrypted, ip, userAgent); err != nil {
		return "", uuid.Nil, fmt.Errorf("insert session: %w", err)
	}
	return token, sessionID, nil
}

// Validate looks up a refresh token and returns its session record. Returns
// ErrSessionNotFound if hash unknown, ErrSessionRevoked if revoked, or an
// error if the session has been idle longer than RefreshTokenInactivityTTL.
func (s *SessionStore) Validate(ctx context.Context, token string) (*SessionRecord, error) {
	hash := hashToken(token)
	const q = `
		SELECT id, user_id, COALESCE(bitrix_refresh_token_encrypted, ''), COALESCE(ip::text, ''),
		       COALESCE(user_agent, ''), created_at, last_used_at, revoked_at
		FROM session
		WHERE refresh_token_hash = $1
	`
	row := s.pool.QueryRow(ctx, q, hash)
	rec := &SessionRecord{}
	if err := row.Scan(&rec.ID, &rec.UserID, &rec.BitrixRefreshTokenEncrypted, &rec.IP,
		&rec.UserAgent, &rec.CreatedAt, &rec.LastUsedAt, &rec.RevokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, fmt.Errorf("select session: %w", err)
	}
	if rec.RevokedAt != nil {
		return nil, ErrSessionRevoked
	}
	if time.Since(rec.LastUsedAt) > RefreshTokenInactivityTTL {
		// Idle session — revoke and return as not-found to caller.
		_ = s.Revoke(ctx, rec.ID)
		return nil, ErrSessionRevoked
	}
	return rec, nil
}

// Touch updates last_used_at to now. Called on successful refresh.
func (s *SessionStore) Touch(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE session SET last_used_at = NOW() WHERE id = $1`, id)
	return err
}

// Revoke marks a session revoked. Idempotent.
func (s *SessionStore) Revoke(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE session SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`, id)
	return err
}

// RevokeAllForUser revokes every active session of a user. Used by admin
// "force-logout" (per spec) and on user-block (per spec).
func (s *SessionStore) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE session SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
		userID)
	return err
}
