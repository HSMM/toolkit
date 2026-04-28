// Package livekit — тонкий клиент для LiveKit OSS:
//   - MintJoinToken — JWT HS256 access-токен для участника
//   - EndRoom — Twirp DeleteRoom
//   - StartRoomCompositeEgress / StartRoomCompositeAudioEgress / StopEgress — запись
//   - VerifyAndParseWebhook — приём событий комнат и egress
//
// Полный server-sdk-go не подключаем — нашего набора Twirp вызовов достаточно,
// и зависимостей сильно меньше.
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
	RoomRecord     bool   `json:"roomRecord,omitempty"` // нужно для Egress Twirp-вызовов
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
			RoomRecord: true, // для StartParticipantEgress / StopEgress
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
	return c.twirp(ctx, "RoomService", room, "DeleteRoom", map[string]string{"room": room}, nil)
}

// LKTrack — срез TrackInfo из ListParticipants. Type: "AUDIO"|"VIDEO"|"DATA",
// Source: "CAMERA"|"MICROPHONE"|"SCREEN_SHARE"|"SCREEN_SHARE_AUDIO"|"UNKNOWN".
type LKTrack struct {
	Sid    string `json:"sid"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Muted  bool   `json:"muted,omitempty"`
}

// LKParticipant — срез из ListParticipants. tracks нужны для TrackEgress.
type LKParticipant struct {
	Identity string    `json:"identity"`
	State    string    `json:"state"` // ACTIVE | JOINED | DISCONNECTED — нас интересует ACTIVE
	Tracks   []LKTrack `json:"tracks,omitempty"`
}

// ListParticipants возвращает текущих participant'ов в комнате (по живой картинке LK,
// независимо от participant table в нашей БД).
func (c *Client) ListParticipants(ctx context.Context, room string) ([]LKParticipant, error) {
	var resp struct {
		Participants []LKParticipant `json:"participants"`
	}
	if err := c.twirp(ctx, "RoomService", room, "ListParticipants",
		map[string]string{"room": room}, &resp); err != nil {
		return nil, err
	}
	return resp.Participants, nil
}

// ─────────────────────────────────────────────────────────────────────────
// Egress: запись комнаты в S3 (MinIO). Доступны два варианта:
//   - StartRoomCompositeEgress       → MP4 (видео+аудио grid)
//   - StartRoomCompositeAudioEgress  → OGG (только смикшированное аудио)
//   - StartParticipantAudioEgress    → OGG, отдельный файл на участника
// ─────────────────────────────────────────────────────────────────────────

// S3Config описывает S3-совместимое хранилище (MinIO в нашем случае).
type S3Config struct {
	AccessKey      string
	Secret         string
	Endpoint       string // http://minio:9000 (LiveKit резолвит в docker-сети)
	Region         string
	Bucket         string
	ForcePathStyle bool
}

// StartTrackEgress стартует TrackEgress (per-track raw dump в файл). По
// сравнению с ParticipantEgress преимущества:
//   • никакого транскодинга — записывается прямо опубликованный кодек,
//     для микрофона это Opus, упакованный в OGG-контейнер по расширению;
//   • никаких codec/encoding-options полей в proto — TrackEgress использует
//     DirectFileOutput, он простой и не цепляет proto3 oneof issue;
//   • ParticipantEgress в нашей версии LK не уважает audio_only — пишет
//     видео+аудио MP4 даже когда флаг выставлен. TrackEgress по природе
//     записывает строго один трек.
//
// trackID — sid аудио-трека участника (получаем через ListParticipants).
// filepath — расширение .ogg даст OGG/Opus, .webm — WebM/Opus и т.п.
//
// Возвращает egress_id.
func (c *Client) StartTrackEgress(ctx context.Context, room, trackID, filepath string, s3 S3Config) (string, error) {
	body := map[string]any{
		"room_name": room,
		"track_id":  trackID,
		// oneof output { file | websocket_url } — выставляем file.
		"file": map[string]any{
			"filepath": filepath,
			"s3":       s3.json(),
		},
	}
	var resp egressInfoMin
	if err := c.twirp(ctx, "Egress", room, "StartTrackEgress", body, &resp); err != nil {
		return "", err
	}
	return resp.EgressID, nil
}

// StartRoomCompositeEgress — одна запись на всю комнату: видео-grid + микшированное аудио,
// MP4 в S3. Используется для «полной» записи встречи.
//
// layout — "grid" (по умолчанию), "speaker", "single-speaker" — см. LiveKit docs.
func (c *Client) StartRoomCompositeEgress(ctx context.Context, room, layout, filepath string, s3 S3Config) (string, error) {
	if layout == "" {
		layout = "grid"
	}
	body := map[string]any{
		"room_name": room,
		"layout":    layout,
		// 1080p30 = ~4.5 Мбит/с, h.264 high; на уровне Jitsi/Zoom recording.
		// Если CPU egress'а станет узким местом — снизим до 720P_30.
		"preset": "H264_1080P_30",
		"file_outputs": []any{
			map[string]any{
				"file_type": "MP4",
				"filepath":  filepath,
				"s3":        s3.json(),
			},
		},
	}
	var resp egressInfoMin
	if err := c.twirp(ctx, "Egress", room, "StartRoomCompositeEgress", body, &resp); err != nil {
		return "", err
	}
	return resp.EgressID, nil
}

// StartRoomCompositeAudioEgress — то же что выше, но audio_only=true.
// Файл — OGG/Opus с микшированным аудио всех participant'ов комнаты.
// Используется параллельно с видео-композитом для получения транскрибируемой
// дорожки (видео-MP4 не подходит для GigaAM напрямую).
func (c *Client) StartRoomCompositeAudioEgress(ctx context.Context, room, filepath string, s3 S3Config) (string, error) {
	body := map[string]any{
		"room_name":  room,
		"audio_only": true,
		"file_outputs": []any{
			map[string]any{
				"file_type": "OGG",
				"filepath":  filepath,
				"s3":        s3.json(),
			},
		},
	}
	var resp egressInfoMin
	if err := c.twirp(ctx, "Egress", room, "StartRoomCompositeEgress", body, &resp); err != nil {
		return "", err
	}
	return resp.EgressID, nil
}

func (s S3Config) json() map[string]any {
	return map[string]any{
		"access_key":       s.AccessKey,
		"secret":           s.Secret,
		"endpoint":         s.Endpoint,
		"region":           s.Region,
		"bucket":           s.Bucket,
		"force_path_style": s.ForcePathStyle,
	}
}

// StopEgress останавливает запись по id. Идемпотентно — already-stopped возвращает OK.
func (c *Client) StopEgress(ctx context.Context, egressID string) error {
	if egressID == "" {
		return errors.New("egress id required")
	}
	return c.twirp(ctx, "Egress", "", "StopEgress", map[string]string{"egress_id": egressID}, nil)
}

// egressInfoMin — нам из ответа нужен только id (статус увидим в webhook).
type egressInfoMin struct {
	EgressID string `json:"egress_id"`
	Status   string `json:"status"`
}

// twirp выполняет Twirp-вызов /twirp/livekit.<Service>/<method>.
// Service: "RoomService" | "Egress".
func (c *Client) twirp(ctx context.Context, service, room, method string, in any, out any) error {
	tok, err := c.mintAdminToken(room)
	if err != nil {
		return fmt.Errorf("mint admin token: %w", err)
	}
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	url := fmt.Sprintf("%s/twirp/livekit.%s/%s", c.baseURL, service, method)
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
