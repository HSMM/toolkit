// Package gigaam — клиент к внешнему ASR-сервису GigaAM.
//
// Контракт:
//   POST /stt/transcribe        multipart/form-data, поле "file"  → 202 + {task_id, status}
//   GET  /stt/result/{task_id}  → {task_id, status, result?, execution_time?}
//
// Polling-модель: после Submit вызывающий код опрашивает Poll каждые
// PollInterval, пока status != "processing"/"queued". Завершённые статусы:
// "completed" и "error".
//
// На стороне GigaAM могут быть включены DEORIZATION (поле channel в сегментах)
// и EMO (поле emo). Клиент возвращает обе формы через единый ResultPayload.
package gigaam

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Status соответствует статусам задачи GigaAM.
type Status string

const (
	StatusQueued     Status = "queued"
	StatusProcessing Status = "processing"
	StatusCompleted  Status = "completed"
	StatusError      Status = "error"
)

// Segment — один сегмент транскрипта (фраза). Поле Channel заполняется только
// если на инстансе GigaAM включена диаризация (DEORIZATION_IS_ENABLED=true)
// и аудио было стерео.
type Segment struct {
	Segment int     `json:"segment"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
	Channel *int    `json:"channel,omitempty"`
}

// Emotions — softmax-распределение эмоций по аудио. Заполняется только если
// EMO_MODEL_IS_ENABLED=true. В моно — один словарь, в стерео — массив на
// канал.
type Emotions struct {
	Angry    float64 `json:"angry"`
	Sad      float64 `json:"sad"`
	Neutral  float64 `json:"neutral"`
	Positive float64 `json:"positive"`
}

// EmotionsByChannel — стерео-вариант эмоций.
type EmotionsByChannel struct {
	Channel  int      `json:"channel"`
	Emotions Emotions `json:"emotions"`
}

// ResultPayload — содержимое поля result в ответе /stt/result.
//
// Поле Emo полиморфно: в моно — Emotions, в стерео — []EmotionsByChannel,
// либо null. Распарсивается лениво в EmoMono / EmoStereo getters.
type ResultPayload struct {
	Segments      []Segment       `json:"segments"`
	Message       string          `json:"message"`
	Emo           json.RawMessage `json:"emo"`
	ExecutionTime float64         `json:"execution_time,omitempty"`
}

// EmoMono декодирует моно-форму. (nil, false) если EMO выключен или стерео.
func (r *ResultPayload) EmoMono() (*Emotions, bool) {
	if len(r.Emo) == 0 || string(r.Emo) == "null" {
		return nil, false
	}
	var e Emotions
	if err := json.Unmarshal(r.Emo, &e); err != nil {
		return nil, false
	}
	return &e, true
}

// EmoStereo декодирует стерео-форму. (nil, false) если EMO выключен или моно.
func (r *ResultPayload) EmoStereo() ([]EmotionsByChannel, bool) {
	if len(r.Emo) == 0 || string(r.Emo) == "null" {
		return nil, false
	}
	var arr []EmotionsByChannel
	if err := json.Unmarshal(r.Emo, &arr); err != nil {
		return nil, false
	}
	return arr, true
}

// SubmitResponse — ответ POST /stt/transcribe.
type SubmitResponse struct {
	TaskID string `json:"task_id"`
	Status Status `json:"status"`
}

// PollResponse — ответ GET /stt/result/{task_id}.
type PollResponse struct {
	TaskID        string         `json:"task_id"`
	Status        Status         `json:"status"`
	Result        *ResultPayload `json:"result,omitempty"`
	ExecutionTime float64        `json:"execution_time,omitempty"`
	STTModel      string         `json:"stt_model,omitempty"`
	Log           any            `json:"log,omitempty"`
}

// Client — HTTP-клиент к GigaAM.
type Client struct {
	baseURL    *url.URL
	token      string
	httpClient *http.Client
}

// Option конфигурирует Client.
type Option func(*Client)

// WithHTTPClient заменяет встроенный *http.Client (для тестов и тонкой
// настройки таймаутов / retry-обёрток).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.httpClient = h } }

// New создаёт клиент. baseURL — например "http://gigaam.internal:8000".
// token может быть пустым (на placeholder-инстансе аутентификация не нужна).
func New(baseURL, token string, opts ...Option) (*Client, error) {
	if baseURL == "" {
		return nil, errors.New("gigaam: empty base URL")
	}
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("gigaam: parse base URL: %w", err)
	}
	c := &Client{
		baseURL: u,
		token:   token,
		httpClient: &http.Client{
			Timeout: 5 * time.Minute, // upload крупного файла может быть долгим
		},
	}
	for _, o := range opts {
		o(c)
	}
	return c, nil
}

// Submit грузит аудиопоток в GigaAM, возвращает task_id для polling.
//
// audio должен быть seekable если хочется делать ретраи (мы не делаем — на
// уровень выше). filename даёт серверу подсказку по расширению (для ffmpeg).
func (c *Client) Submit(ctx context.Context, audio io.Reader, filename string) (*SubmitResponse, error) {
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		return nil, fmt.Errorf("gigaam: form file: %w", err)
	}
	if _, err := io.Copy(part, audio); err != nil {
		return nil, fmt.Errorf("gigaam: copy audio: %w", err)
	}
	if err := mw.Close(); err != nil {
		return nil, fmt.Errorf("gigaam: close multipart: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.urlPath("/stt/transcribe"), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gigaam: do submit: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("gigaam submit: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var out SubmitResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("gigaam: decode submit response: %w", err)
	}
	if out.TaskID == "" {
		return nil, errors.New("gigaam: empty task_id in submit response")
	}
	return &out, nil
}

// Poll возвращает текущий статус и (если ready) результат.
func (c *Client) Poll(ctx context.Context, taskID string) (*PollResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.urlPath("/stt/result/"+url.PathEscape(taskID)), nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gigaam: do poll: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("gigaam poll: task %s not found", taskID)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("gigaam poll: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var out PollResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("gigaam: decode poll response: %w", err)
	}
	return &out, nil
}

// IsTerminal возвращает true для статусов, после которых polling не имеет смысла.
func IsTerminal(s Status) bool {
	return s == StatusCompleted || s == StatusError
}

func (c *Client) urlPath(p string) string {
	u := *c.baseURL
	u.Path = strings.TrimRight(u.Path, "/") + p
	return u.String()
}
