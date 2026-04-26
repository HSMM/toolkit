package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

// OAuthStateTTL — short window between /login redirect and Bitrix24 callback.
const OAuthStateTTL = 10 * time.Minute

// OAuthStateMinter creates and verifies CSRF-protection state parameters
// for the OAuth2 authorization-code flow with Bitrix24.
//
// Format: base64url(nonce || ts || hmac_sha256(secret, nonce || ts))
// The state encodes its own expiry — no DB roundtrip needed for verify.
type OAuthStateMinter struct {
	secret []byte
}

func NewOAuthStateMinter(secret string) *OAuthStateMinter {
	return &OAuthStateMinter{secret: []byte(secret)}
}

// Mint returns a fresh state token to be sent as ?state= in the auth URL.
// returnPath (where to redirect after success) is opaquely embedded in nonce.
func (m *OAuthStateMinter) Mint(returnPath string) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	body := append(nonce, []byte(fmt.Sprintf("%d|%s", time.Now().Unix(), returnPath))...)
	mac := hmac.New(sha256.New, m.secret)
	mac.Write(body)
	tag := mac.Sum(nil)

	return base64.RawURLEncoding.EncodeToString(body) + "." +
		base64.RawURLEncoding.EncodeToString(tag), nil
}

// Verify validates state, returns embedded returnPath. Errors on bad
// signature, malformed input, or expired state.
func (m *OAuthStateMinter) Verify(state string) (returnPath string, err error) {
	parts := strings.SplitN(state, ".", 2)
	if len(parts) != 2 {
		return "", ErrInvalidToken
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("%w: state body", ErrInvalidToken)
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("%w: state tag", ErrInvalidToken)
	}

	mac := hmac.New(sha256.New, m.secret)
	mac.Write(body)
	if !hmac.Equal(tag, mac.Sum(nil)) {
		return "", ErrInvalidToken
	}

	// body = 16 bytes nonce || "<ts>|<returnPath>"
	if len(body) <= 16 {
		return "", ErrInvalidToken
	}
	rest := string(body[16:])
	bar := strings.IndexByte(rest, '|')
	if bar < 0 {
		return "", ErrInvalidToken
	}
	tsStr, returnPath := rest[:bar], rest[bar+1:]
	var ts int64
	if _, err := fmt.Sscanf(tsStr, "%d", &ts); err != nil {
		return "", ErrInvalidToken
	}
	if time.Since(time.Unix(ts, 0)) > OAuthStateTTL {
		return "", errors.New("auth: oauth state expired")
	}
	return returnPath, nil
}
