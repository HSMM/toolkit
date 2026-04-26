// Package storage — обёртка над MinIO/S3 для записи/чтения объектов и
// генерации подписанных URL (TTL 15 мин per ТЗ 5.2.3).
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Buckets — фиксированные имена бакетов в нашем стеке (см. .env.example).
type Buckets struct {
	Recordings string
	Reports    string
	Backups    string
}

// Config — параметры подключения к MinIO/S3.
type Config struct {
	Endpoint  string // host:port или https://host
	AccessKey string
	SecretKey string
	UseSSL    bool
	Region    string
	Buckets   Buckets
}

// Client — обёртка с типизированными методами.
type Client struct {
	mc      *minio.Client
	buckets Buckets
}

// New собирает клиента и проверяет соединение быстрым ListBuckets.
// endpoint можно передать с префиксом scheme — он будет нормализован.
func New(ctx context.Context, cfg Config) (*Client, error) {
	endpoint := strings.TrimPrefix(strings.TrimPrefix(cfg.Endpoint, "https://"), "http://")
	useSSL := cfg.UseSSL || strings.HasPrefix(cfg.Endpoint, "https://")

	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: useSSL,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: minio.New: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := mc.ListBuckets(pingCtx); err != nil {
		return nil, fmt.Errorf("storage: ping (ListBuckets) failed: %w", err)
	}

	if cfg.Buckets.Recordings == "" {
		return nil, errors.New("storage: empty Recordings bucket name")
	}
	return &Client{mc: mc, buckets: cfg.Buckets}, nil
}

// PutOpts — параметры для Put. ContentType обязателен; Size — длина reader'а
// (используем -1 если неизвестна, тогда будет multipart).
type PutOpts struct {
	ContentType string
	Size        int64
}

// PutRecording загружает поток в бакет recordings под указанным ключом.
// Возвращает {bucket, key, size_bytes}.
func (c *Client) PutRecording(ctx context.Context, key string, r io.Reader, opts PutOpts) (bucket, gotKey string, size int64, err error) {
	info, err := c.mc.PutObject(ctx, c.buckets.Recordings, key, r, opts.Size, minio.PutObjectOptions{
		ContentType: opts.ContentType,
	})
	if err != nil {
		return "", "", 0, fmt.Errorf("storage: put recording: %w", err)
	}
	return c.buckets.Recordings, key, info.Size, nil
}

// GetRecording возвращает читаемый поток объекта. Caller обязан Close.
func (c *Client) GetRecording(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := c.mc.GetObject(ctx, c.buckets.Recordings, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("storage: get recording: %w", err)
	}
	// minio.Object реализует io.ReadCloser, но GetObject не делает запрос —
	// он сделает его при первом Read. Это нас устраивает.
	return obj, nil
}

// DeleteRecording удаляет объект. Идемпотентно (no-op если объект отсутствует).
func (c *Client) DeleteRecording(ctx context.Context, key string) error {
	if err := c.mc.RemoveObject(ctx, c.buckets.Recordings, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("storage: delete recording: %w", err)
	}
	return nil
}

// PresignedGetRecording отдаёт подписанную ссылку на скачивание (TTL 15 мин
// по ТЗ 5.2.3). filename используется в Content-Disposition при скачивании.
func (c *Client) PresignedGetRecording(ctx context.Context, key, filename string) (string, error) {
	const ttl = 15 * time.Minute
	reqParams := make(url.Values)
	if filename != "" {
		reqParams.Set("response-content-disposition", `attachment; filename="`+filename+`"`)
	}
	u, err := c.mc.PresignedGetObject(ctx, c.buckets.Recordings, key, ttl, reqParams)
	if err != nil {
		return "", fmt.Errorf("storage: presigned get: %w", err)
	}
	return u.String(), nil
}

// Buckets возвращает имена бакетов (для логов и smoke-проверок).
func (c *Client) Buckets() Buckets { return c.buckets }
