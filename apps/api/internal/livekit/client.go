// Package livekit — тонкий клиент для LiveKit OSS:
//   - MintJoinToken / MintAdminToken — JWT HS256 с грантами video.* (без зависимости от server-sdk-go)
//   - EndRoom — Twirp DeleteRoom
//
// Полный SDK не подключаем намеренно: для текущего MVP (создать комнату при
// первом подключении, выдать токен, принудительно завершить) хватает 2 RPC.
// Если позже понадобится UpdateParticipant / SendData / Egress API — можно
// либо расширить этот клиент, либо подключить github.com/livekit/server-sdk-go.
package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Config — то, что Client получает на старте.
type Config struct {
	APIKey    string
	APISecret string
	URL       string // напр. http://livekit:7880 (внутренний Twirp endpoint)
	HTTP      *http.Client
}

type Client struct {
	apiKey    string
	apiSecret []byte
	baseURL   string
	http      *http.Client
}

func New(cfg Config) (*Client, error) {
	if cfg.APIKey == "" || cfg.APISecret == "" {
		return nil, errors.New("livekit: api key / secret required")
	}
	if cfg.URL == "" {
		return nil, errors.New("livekit: URL required")
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	return &Client{
		apiKey:    cfg.APIKey,
		apiSecret: []byte(cfg.APISecret),
		baseURL:   cfg.URL,
		http:      hc,
	}, nil
}

// videoGrant — claim, который читает LiveKit для авторизации join/admin.
// Поля совпадают с server-sdk-go (video.VideoGrant); JSON-теги обязательны.
type videoGrant struct {
	Room           string `json:"room,omitempty"`
	RoomJoin       bool   `json:"roomJoin,omitempty"`
	RoomCreate     bool   `json:"roomCreate,omitempty"`
	RoomAdmin      bool   `json:"roomAdmin,omitempty"`
	RoomList       bool   `json:"roomList,omitempty"`
	CanPublish     *bool  `json:"canPublish,omitempty"`
	CanSubscribe   *bool  `json:"canSubscribe,omitempty"`
	CanPublishData *bool  `json:"canPublishData,omitempty"`
	Hidden         bool   `json:"hidden,omitempty"`
	Recorder       bool   `json:"recorder,omitempty"`
}

type lkClaims struct {
	Video    videoGrant `json:"video,omitempty"`
	Name     string     `json:"name,omitempty"`
	Metadata string     `json:"metadata,omitempty"`
	jwt.RegisteredClaims
}

// JoinTokenOptions — параметры выпуска токена для участника.
type JoinTokenOptions struct {
	Room     string        // имя room (обычно meeting.livekit_room_id)
	Identity string        // уникальный participant identity (user_id или guest_id)
	Name     string        // отображаемое имя
	Metadata string        // произвольная JSON-строка (роль, бейджи, аватар)
	TTL      time.Duration // 0 → 6h
	CanPub   bool          // true для гостей/участников; false для observer/recorder
	CanSub   bool          // обычно true
	CanData  bool          // чат / data-канал
	Admin    bool          // право управлять комнатой (выкинуть участника, mute)
	Hidden   bool          // не показывать другим участникам (например, бот-рекордер)
}

// MintJoinToken создаёт LiveKit access token (JWT HS256).
func (c *Client) MintJoinToken(opts JoinTokenOptions) (string, error) {
	if opts.Room == "" || opts.Identity == "" {
		return "", errors.New("livekit: room and identity required")
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = 6 * time.Hour
	}
	now := time.Now()
	bp := func(b bool) *bool { return &b }

	claims := lkClaims{
		Name:     opts.Name,
		Metadata: opts.Metadata,
		Video: videoGrant{
			Room:           opts.Room,
			RoomJoin:       true,
			RoomAdmin:      opts.Admin,
			CanPublish:     bp(opts.CanPub),
			CanSubscribe:   bp(opts.CanSub),
			CanPublishData: bp(opts.CanData),
			Hidden:         opts.Hidden,
		},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    c.apiKey,
			Subject:   opts.Identity,
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(c.apiSecret)
}

// mintAdminToken — короткоживущий токен с RoomAdmin для серверных вызовов
// Twirp (DeleteRoom, RemoveParticipant). identity ставим "toolkit-server".
func (c *Client) mintAdminToken(room string) (string, error) {
	now := time.Now()
	claims := lkClaims{
		Video: videoGrant{
			Room:       room,
			RoomCreate: true,
			RoomAdmin:  true,
			RoomList:   true,
		},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    c.apiKey,
			Subject:   "toolkit-server",
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(2 * time.Minute)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(c.apiSecret)
}

// EndRoom принудительно завершает комнату. Все участники получают disconnect.
// Идемпотентно: если комнаты нет — вернёт OK, не ошибку.
func (c *Client) EndRoom(ctx context.Context, room string) error {
	return c.twirp(ctx, room, "DeleteRoom", map[string]string{"room": room}, nil)
}

// twirp выполняет Twirp-вызов /twirp/livekit.RoomService/<method>.
func (c *Client) twirp(ctx context.Context, room, method string, in any, out any) error {
	tok, err := c.mintAdminToken(room)
	if err != nil {
		return fmt.Errorf("mint admin token: %w", err)
	}
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	url := fmt.Sprintf("%s/twirp/livekit.RoomService/%s", c.baseURL, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("livekit %s: %w", method, err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("livekit %s: http %d: %s", method, resp.StatusCode, string(raw))
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("livekit %s decode: %w", method, err)
		}
	}
	return nil
}
