package livekit

// Webhook signature verification + event parsing.
//
// LiveKit подписывает webhook'и так:
//   Заголовок: Authorization: <JWT HS256 без префикса Bearer>
//   В JWT-claims:
//     iss = api_key (как у access-токенов)
//     sub = "" или произвольное
//     exp = unix timestamp
//     sha256 = base64(sha256(http body))   // защищает целостность тела
//
// Проверяем: подпись JWT собственным API secret + сравниваем sha256 с фактическим.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/golang-jwt/jwt/v5"
)

// WebhookEvent — минимальный срез того, что LiveKit отправляет.
// Полная схема в google.protobuf — нам нужны только событие и EgressInfo.
type WebhookEvent struct {
	Event       string      `json:"event"`        // room_started/room_finished/participant_joined/participant_left/egress_started/egress_updated/egress_ended/...
	Room        *RoomInfo   `json:"room,omitempty"`
	Participant *PartInfo   `json:"participant,omitempty"`
	EgressInfo  *EgressInfo `json:"egressInfo,omitempty"`
	CreatedAt   int64       `json:"createdAt,omitempty"`
}

type RoomInfo struct {
	Sid  string `json:"sid,omitempty"`
	Name string `json:"name,omitempty"`
}

type PartInfo struct {
	Sid      string `json:"sid,omitempty"`
	Identity string `json:"identity,omitempty"`
	Name     string `json:"name,omitempty"`
	State    string `json:"state,omitempty"`
}

// EgressInfo — статус и результаты записи. На egress_ended нас интересуют
// FileResults: каждый объект содержит итоговое имя файла + (опционально) location.
type EgressInfo struct {
	EgressID    string         `json:"egressId,omitempty"`
	RoomID      string         `json:"roomId,omitempty"`
	RoomName    string         `json:"roomName,omitempty"`
	Status      string         `json:"status,omitempty"` // EGRESS_ACTIVE/COMPLETE/FAILED/...
	StartedAt   int64          `json:"startedAt,omitempty"`
	EndedAt     int64          `json:"endedAt,omitempty"`
	UpdatedAt   int64          `json:"updatedAt,omitempty"`
	Error       string         `json:"error,omitempty"`
	FileResults []*FileResult  `json:"fileResults,omitempty"`
	// Из ParticipantEgressRequest (если был — здесь придёт identity).
	ParticipantRequest *ParticipantRequest `json:"participant,omitempty"`
}

type FileResult struct {
	Filename string `json:"filename,omitempty"` // имя в S3 после {template} substitution
	Location string `json:"location,omitempty"` // S3 URL (s3://bucket/key или https://endpoint/bucket/key)
	Size     int64  `json:"size,omitempty"`     // байты
	Duration int64  `json:"duration,omitempty"` // наносекунды
	StartedAt int64 `json:"startedAt,omitempty"`
	EndedAt   int64 `json:"endedAt,omitempty"`
}

type ParticipantRequest struct {
	RoomName  string `json:"roomName,omitempty"`
	Identity  string `json:"identity,omitempty"`
	AudioOnly bool   `json:"audioOnly,omitempty"`
}

// VerifyAndParseWebhook читает тело запроса, проверяет подпись и парсит JSON.
// Должен вызываться из http handler'а. Возвращает событие или ошибку.
func (c *Client) VerifyAndParseWebhook(r *http.Request) (*WebhookEvent, error) {
	authz := r.Header.Get("Authorization")
	if authz == "" {
		return nil, errors.New("missing Authorization header")
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	defer r.Body.Close()

	type webhookClaims struct {
		Sha256 string `json:"sha256"`
		jwt.RegisteredClaims
	}
	claims := &webhookClaims{}
	tok, err := jwt.ParseWithClaims(authz, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return c.apiSecret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !tok.Valid {
		return nil, fmt.Errorf("invalid webhook JWT: %v", err)
	}

	// Проверяем хэш тела.
	want := claims.Sha256
	got := base64.StdEncoding.EncodeToString(sha256Sum(body))
	if want != got {
		return nil, fmt.Errorf("webhook body hash mismatch")
	}

	var ev WebhookEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, fmt.Errorf("unmarshal webhook event: %w", err)
	}
	return &ev, nil
}

func sha256Sum(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}
