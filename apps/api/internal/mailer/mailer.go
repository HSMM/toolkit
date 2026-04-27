// Package mailer — простой SMTP-сендер. Конфиг тянется на лету из
// system_setting (ключ smtp_config), отдельной env-переменной нет — админ
// настраивает SMTP в UI Settings → SMTP.
package mailer

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config — конфиг SMTP, который хранится в system_setting/smtp_config.
// Дублирует sysset.SMTPConfig (поля совпадают по JSON-тегам). Дублирование,
// чтобы не тянуть зависимость mailer→sysset (sysset уже зависит от auth/db).
type Config struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Encryption string `json:"encryption"` // "ssl" | "starttls" | "none" | ""
	User       string `json:"user"`
	Password   string `json:"password"`
	FromName   string `json:"from_name"`
	FromEmail  string `json:"from_email"`
}

func (c Config) Configured() bool {
	return strings.TrimSpace(c.Host) != "" && c.Port > 0 && strings.TrimSpace(c.FromEmail) != ""
}

// Client — обёртка над net/smtp с lazy-loaded конфигом из БД.
type Client struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Client { return &Client{db: db} }

// LoadConfig читает текущий smtp_config из system_setting. Возвращает (Config{}, nil)
// если ключ ещё не создавался — Configured() даст false.
func (c *Client) LoadConfig(ctx context.Context) (Config, error) {
	var cfg Config
	var raw []byte
	err := c.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='smtp_config'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	_ = json.Unmarshal(raw, &cfg)
	return cfg, nil
}

// Message — одно письмо.
type Message struct {
	To       []string // адресаты
	Subject  string
	HTMLBody string
	TextBody string // опц.; если пуст — отправляем только HTML
}

// Send отправляет письмо синхронно. Используется как из job-handler'а,
// так и из admin "test send" (когда появится).
func (c *Client) Send(ctx context.Context, msg Message) error {
	cfg, err := c.LoadConfig(ctx)
	if err != nil {
		return fmt.Errorf("load smtp config: %w", err)
	}
	if !cfg.Configured() {
		return errors.New("smtp не настроен (Settings → SMTP)")
	}
	if len(msg.To) == 0 {
		return errors.New("no recipients")
	}

	addr := net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.Port))

	from := cfg.FromEmail
	fromHeader := from
	if cfg.FromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", mime.QEncoding.Encode("utf-8", cfg.FromName), from)
	}

	var auth smtp.Auth
	if cfg.User != "" {
		auth = smtp.PlainAuth("", cfg.User, cfg.Password, cfg.Host)
	}

	body := buildMessage(fromHeader, msg)

	switch strings.ToLower(cfg.Encryption) {
	case "ssl":
		// Implicit TLS (обычно порт 465).
		return sendSMTPS(ctx, addr, cfg.Host, auth, from, msg.To, body)
	case "starttls":
		// Explicit TLS upgrade на plain-соединении (обычно порт 587/25).
		return sendSTARTTLS(ctx, addr, cfg.Host, auth, from, msg.To, body)
	case "none", "":
		// Plain SMTP без шифрования. net/smtp поднимет STARTTLS автоматически
		// если сервер его рекламирует — но если нет, отправит в открытом виде.
		return smtp.SendMail(addr, auth, from, msg.To, body)
	default:
		return fmt.Errorf("unsupported encryption: %q", cfg.Encryption)
	}
}

func buildMessage(fromHeader string, msg Message) []byte {
	var b strings.Builder
	b.WriteString("From: ")
	b.WriteString(fromHeader)
	b.WriteString("\r\n")
	b.WriteString("To: ")
	b.WriteString(strings.Join(msg.To, ", "))
	b.WriteString("\r\n")
	b.WriteString("Subject: ")
	b.WriteString(mime.QEncoding.Encode("utf-8", msg.Subject))
	b.WriteString("\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.HTMLBody)
	return []byte(b.String())
}

func sendSMTPS(ctx context.Context, addr, host string, auth smtp.Auth, from string, to []string, body []byte) error {
	d := &net.Dialer{}
	conn, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err != nil {
		return fmt.Errorf("smtps dial: %w", err)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtps client: %w", err)
	}
	defer c.Close()
	return doSMTPSession(c, auth, from, to, body)
}

func sendSTARTTLS(ctx context.Context, addr, host string, auth smtp.Auth, from string, to []string, body []byte) error {
	c, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	defer c.Close()
	if err := c.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
		return fmt.Errorf("starttls: %w", err)
	}
	return doSMTPSession(c, auth, from, to, body)
}

func doSMTPSession(c *smtp.Client, auth smtp.Auth, from string, to []string, body []byte) error {
	if auth != nil {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("auth: %w", err)
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("mail: %w", err)
	}
	for _, addr := range to {
		if err := c.Rcpt(addr); err != nil {
			return fmt.Errorf("rcpt %s: %w", addr, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("data write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("data close: %w", err)
	}
	return c.Quit()
}
