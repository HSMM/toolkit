// Package config loads runtime configuration from environment variables.
// Source of truth for variable names and defaults: ../../.env.example.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Env      string // "dev" | "prod"
	HTTPPort int

	DatabaseURL    string
	MigrationsPath string

	// Auth
	JWTSecret              string
	BaseURL                string   // public origin, e.g. https://toolkit.example.com
	BootstrapAdmins        []string // emails from TOOLKIT_BOOTSTRAP_ADMINS
	AllowedCORSOrigins     []string // for browser SPA origins

	// Bitrix24 OAuth (local app)
	BitrixPortalURL    string
	BitrixClientID     string
	BitrixClientSecret string
	BitrixAppToken     string

	// External services
	FreePBXWSSURL    string
	FreePBXExtension string
	FreePBXExtPwd    string

	GigaAMAPIURL          string
	GigaAMAPIToken        string
	GigaAMPollInterval    int // seconds
	GigaAMMaxRetries      int
	GigaAMConcurrentLimit int

	// MinIO / S3-совместимое хранилище
	MinioEndpoint         string // host:port (без scheme) или https://host
	MinioAccessKey        string
	MinioSecretKey        string
	MinioUseSSL           bool
	MinioRegion           string
	MinioBucketRecordings string
	MinioBucketReports    string
	MinioBucketBackups    string

	// SMTP
	SMTPHost     string
	SMTPPort     int
	SMTPUser     string
	SMTPPassword string
	SMTPFrom     string

	// Worker pool
	WorkerConcurrency int

	// Rate limit defaults
	RateLimitGlobalPerMin int // requests/IP/min, anonymous endpoints
	RateLimitUserPerMin   int // requests/user/min, authenticated endpoints
}

func Load() (*Config, error) {
	cfg := &Config{
		Env:                getenv("TOOLKIT_ENV", "dev"),
		MigrationsPath:     getenv("MIGRATIONS_PATH", "file:///app/migrations"),
		BaseURL:            getenv("TOOLKIT_BASE_URL", "http://localhost:8080"),
		BootstrapAdmins:    splitCSV(getenv("TOOLKIT_BOOTSTRAP_ADMINS", "")),
		AllowedCORSOrigins: splitCSV(getenv("TOOLKIT_CORS_ORIGINS", "*")),
		BitrixPortalURL:    getenv("BITRIX_PORTAL_URL", ""),
		BitrixClientID:     getenv("BITRIX_CLIENT_ID", ""),
		BitrixClientSecret: getenv("BITRIX_CLIENT_SECRET", ""),
		BitrixAppToken:     getenv("BITRIX_APP_TOKEN", ""),
		FreePBXWSSURL:      getenv("FREEPBX_WSS_URL", ""),
		FreePBXExtension:   getenv("FREEPBX_EXTENSION", ""),
		FreePBXExtPwd:      getenv("FREEPBX_EXTENSION_PASSWORD", ""),
		GigaAMAPIURL:       getenv("GIGAAM_API_URL", ""),
		GigaAMAPIToken:     getenv("GIGAAM_API_TOKEN", ""),
		MinioEndpoint:         getenv("MINIO_ENDPOINT", "minio:9000"),
		MinioAccessKey:        getenv("MINIO_ROOT_USER", ""),
		MinioSecretKey:        getenv("MINIO_ROOT_PASSWORD", ""),
		MinioRegion:           getenv("MINIO_REGION", "us-east-1"),
		MinioBucketRecordings: getenv("MINIO_BUCKET_RECORDINGS", "recordings"),
		MinioBucketReports:    getenv("MINIO_BUCKET_REPORTS", "reports"),
		MinioBucketBackups:    getenv("MINIO_BUCKET_BACKUPS", "backups"),
		MinioUseSSL:           getenv("MINIO_USE_SSL", "") == "true",
		SMTPHost:           getenv("SMTP_HOST", ""),
		SMTPUser:           getenv("SMTP_USER", ""),
		SMTPPassword:       getenv("SMTP_PASSWORD", ""),
		SMTPFrom:           getenv("SMTP_FROM", ""),
	}

	for _, fn := range []func() error{
		func() error { var err error; cfg.HTTPPort, err = intEnv("HTTP_PORT", 8080); return err },
		func() error { var err error; cfg.SMTPPort, err = intEnv("SMTP_PORT", 587); return err },
		func() error { var err error; cfg.WorkerConcurrency, err = intEnv("WORKER_CONCURRENCY", 4); return err },
		func() error { var err error; cfg.GigaAMPollInterval, err = intEnv("GIGAAM_POLL_INTERVAL_SECONDS", 5); return err },
		func() error { var err error; cfg.GigaAMMaxRetries, err = intEnv("GIGAAM_MAX_RETRIES", 3); return err },
		func() error { var err error; cfg.GigaAMConcurrentLimit, err = intEnv("GIGAAM_CONCURRENT_LIMIT", 5); return err },
		func() error { var err error; cfg.RateLimitGlobalPerMin, err = intEnv("RATELIMIT_GLOBAL_PER_MIN", 600); return err },
		func() error { var err error; cfg.RateLimitUserPerMin, err = intEnv("RATELIMIT_USER_PER_MIN", 600); return err },
	} {
		if err := fn(); err != nil {
			return nil, err
		}
	}

	dbURL, err := requireEnv("DATABASE_URL")
	if err != nil {
		return nil, err
	}
	cfg.DatabaseURL = dbURL

	jwt, err := requireEnv("JWT_SECRET")
	if err != nil {
		return nil, err
	}
	if len(jwt) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 bytes (got %d)", len(jwt))
	}
	cfg.JWTSecret = jwt

	return cfg, nil
}

func getenv(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func requireEnv(k string) (string, error) {
	v := os.Getenv(k)
	if v == "" {
		return "", fmt.Errorf("required env var %s is empty", k)
	}
	return v, nil
}

func intEnv(k string, def int) (int, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("env %s must be int: %w", k, err)
	}
	return n, nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
