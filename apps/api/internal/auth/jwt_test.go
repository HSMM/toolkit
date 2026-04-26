package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const testSecret = "test-secret-thats-at-least-32-bytes-long"

func TestJWT_RoundTrip(t *testing.T) {
	j := NewJWTIssuer(testSecret)
	uid := uuid.New()
	sid := uuid.New()
	tok, err := j.Issue(uid, sid, "alice@example.com", RoleUser)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if tok == "" {
		t.Fatal("empty token")
	}

	c, err := j.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if c.UserID != uid {
		t.Errorf("UserID: got %v want %v", c.UserID, uid)
	}
	if c.SessionID != sid {
		t.Errorf("SessionID: got %v want %v", c.SessionID, sid)
	}
	if c.Role != RoleUser {
		t.Errorf("Role: got %v want %v", c.Role, RoleUser)
	}
	if c.Email != "alice@example.com" {
		t.Errorf("Email: got %v", c.Email)
	}
}

func TestJWT_BadSignature(t *testing.T) {
	j1 := NewJWTIssuer(testSecret)
	j2 := NewJWTIssuer("different-secret-also-32-bytes-long-xx")
	tok, err := j1.Issue(uuid.New(), uuid.New(), "x@y.z", RoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j2.Verify(tok); err == nil {
		t.Fatal("expected verification to fail with wrong secret")
	}
}

func TestJWT_Tampered(t *testing.T) {
	j := NewJWTIssuer(testSecret)
	tok, err := j.Issue(uuid.New(), uuid.New(), "x@y.z", RoleUser)
	if err != nil {
		t.Fatal(err)
	}
	// Flip the last char of the signature.
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("expected JWT with 3 parts, got %d", len(parts))
	}
	last := parts[2]
	swap := byte('A')
	if last[len(last)-1] == 'A' {
		swap = 'B'
	}
	parts[2] = last[:len(last)-1] + string(swap)
	tampered := strings.Join(parts, ".")
	if _, err := j.Verify(tampered); err == nil {
		t.Fatal("expected tampered token to fail verification")
	}
}

func TestJWT_Expired(t *testing.T) {
	j := NewJWTIssuer(testSecret)
	// Hand-craft an already-expired token, bypassing TTL.
	now := time.Now().Add(-2 * time.Hour)
	claims := AccessClaims{
		UserID:    uuid.New(),
		SessionID: uuid.New(),
		Email:     "x@y.z",
		Role:      RoleUser,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(15 * time.Minute)),
			Issuer:    "toolkit",
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.Verify(tok); err == nil {
		t.Fatal("expected expired token to fail")
	}
}

func TestJWT_RejectsAlgNone(t *testing.T) {
	j := NewJWTIssuer(testSecret)
	// Forge a token signed with "none" alg.
	header := `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0`
	payload := `eyJ1aWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYWRtaW4ifQ`
	tok := header + "." + payload + "."
	if _, err := j.Verify(tok); err == nil {
		t.Fatal("expected alg=none to be rejected")
	}
}
