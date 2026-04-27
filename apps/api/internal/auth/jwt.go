package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// AccessTokenTTL is the lifetime of issued JWT access tokens (per spec).
const AccessTokenTTL = 15 * time.Minute

// AccessClaims is the payload of a Toolkit JWT access token. We deliberately
// keep this small — heavy data (department, supervises) is loaded fresh per
// request from the user table, never trusted from the token.
type AccessClaims struct {
	UserID    uuid.UUID `json:"uid"`
	Email     string    `json:"email"`
	Role      Role      `json:"role"`
	SessionID uuid.UUID `json:"sid"`
	jwt.RegisteredClaims
}

// JWTIssuer signs and verifies access tokens with HMAC-SHA256.
type JWTIssuer struct {
	secret []byte
}

func NewJWTIssuer(secret string) *JWTIssuer {
	return &JWTIssuer{secret: []byte(secret)}
}

// Issue mints a fresh access token valid for AccessTokenTTL.
func (j *JWTIssuer) Issue(userID, sessionID uuid.UUID, email string, role Role) (string, error) {
	now := time.Now()
	claims := AccessClaims{
		UserID:    userID,
		Email:     email,
		Role:      role,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTokenTTL)),
			Issuer:    "toolkit",
			Subject:   userID.String(),
			ID:        uuid.NewString(),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(j.secret)
}

// Verify parses and validates the token. Returns ErrExpiredToken on expiry,
// ErrInvalidToken on any other validation failure.
func (j *JWTIssuer) Verify(tokenStr string) (*AccessClaims, error) {
	claims := &AccessClaims{}
	tok, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return j.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))

	if err != nil {
		switch {
		case isExpired(err):
			return nil, ErrExpiredToken
		default:
			return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
		}
	}
	if !tok.Valid {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

func isExpired(err error) bool {
	for _, t := range []error{jwt.ErrTokenExpired, jwt.ErrTokenNotValidYet} {
		if jwtErrIs(err, t) {
			return true
		}
	}
	return false
}

// jwtErrIs is a small helper because errors.Is on jwt v5 errors works through
// chains, but we keep this explicit for clarity.
func jwtErrIs(err, target error) bool {
	for err != nil {
		if err == target {
			return true
		}
		// jwt v5 errors implement Unwrap.
		type unwrap interface{ Unwrap() error }
		u, ok := err.(unwrap)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
