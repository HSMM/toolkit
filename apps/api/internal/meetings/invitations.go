package meetings

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/HSMM/toolkit/internal/mailer"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// JobKindSendMeetingInvitation — kind для очереди на отправку email-приглашения.
const JobKindSendMeetingInvitation = "send_meeting_invitation"

// SearchUserResult — минимальный набор полей для multi-select'а в UI.
// Не включает privileged-данные (extension, статус блокировки и пр.) —
// эндпоинт доступен любому authenticated user'у, не только админу.
type SearchUserResult struct {
	ID         uuid.UUID `json:"id"`
	FullName   string    `json:"full_name"`
	Email      string    `json:"email"`
	Department string    `json:"department,omitempty"`
	Position   string    `json:"position,omitempty"`
	AvatarURL  string    `json:"avatar_url,omitempty"`
}

// SearchUsers возвращает активных пользователей, чьё имя/email/отдел содержит q.
// Лимит сверху для защиты от выкачки всей таблицы.
func (s *Service) SearchUsers(ctx context.Context, q string, limit int) ([]SearchUserResult, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	q = strings.TrimSpace(q)
	// Без q возвращаем первые N активных по имени — удобно для дефолтного списка
	// в селекторе.
	const sqlQ = `
		SELECT id, full_name, COALESCE(email,''), COALESCE(department,''),
		       COALESCE(position,''), COALESCE(avatar_url,'')
		  FROM "user"
		 WHERE status = 'active'
		   AND ($1 = '' OR
		        full_name  ILIKE '%' || $1 || '%' OR
		        email      ILIKE '%' || $1 || '%' OR
		        department ILIKE '%' || $1 || '%' OR
		        position   ILIKE '%' || $1 || '%')
		 ORDER BY full_name
		 LIMIT $2
	`
	rows, err := s.db.Query(ctx, sqlQ, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SearchUserResult, 0, limit)
	for rows.Next() {
		var u SearchUserResult
		if err := rows.Scan(&u.ID, &u.FullName, &u.Email, &u.Department, &u.Position, &u.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

// InvitationWorker — обработчик job'ов отправки email-приглашений.
// Регистрируется в worker'е под kind = JobKindSendMeetingInvitation.
type InvitationWorker struct {
	db      *pgxpool.Pool
	m       *mailer.Client
	baseURL string
}

func NewInvitationWorker(db *pgxpool.Pool, m *mailer.Client, baseURL string) *InvitationWorker {
	return &InvitationWorker{db: db, m: m, baseURL: strings.TrimRight(baseURL, "/")}
}

type invitationPayload struct {
	InvitationID uuid.UUID `json:"invitation_id"`
	MeetingID    uuid.UUID `json:"meeting_id"`
}

// Handle отправляет одно приглашение. Возвращает error → queue ретраит с backoff.
// На permanent failure (например meeting удалён) возвращаем nil и помечаем
// invitation как failed, чтобы не зацикливать ретраи.
func (w *InvitationWorker) Handle(ctx context.Context, payload []byte) error {
	var p invitationPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}

	const loadQ = `
		SELECT i.email, i.attempts,
		       m.title, m.scheduled_at, m.started_at, m.guest_link_token,
		       u.full_name
		  FROM meeting_invitation i
		  JOIN meeting m ON m.id = i.meeting_id
		  LEFT JOIN "user" u ON u.id = i.invited_by
		 WHERE i.id = $1
	`
	var (
		email, title, hostName string
		attempts               int
		scheduledAt, startedAt *time.Time
		token                  *string
	)
	err := w.db.QueryRow(ctx, loadQ, p.InvitationID).Scan(
		&email, &attempts, &title, &scheduledAt, &startedAt, &token, &hostName,
	)
	if err == pgx.ErrNoRows {
		// Встреча или приглашение удалены — нечего отправлять.
		return nil
	}
	if err != nil {
		return fmt.Errorf("load invitation: %w", err)
	}

	// Гостевая ссылка ОБЯЗАТЕЛЬНА для письма — иначе адресат не сможет войти.
	// Если ещё не сгенерирована, сгенерируем сейчас.
	guestToken := ""
	if token != nil && *token != "" {
		guestToken = *token
	} else {
		gt, err := randomURLToken(24)
		if err != nil {
			return fmt.Errorf("gen guest token: %w", err)
		}
		if _, err := w.db.Exec(ctx,
			`UPDATE meeting SET guest_link_token = $2 WHERE id = $1 AND guest_link_token IS NULL`,
			p.MeetingID, gt,
		); err != nil {
			return fmt.Errorf("save guest token: %w", err)
		}
		// Перечитаем: вдруг параллельный запрос уже успел сохранить свой token.
		_ = w.db.QueryRow(ctx, `SELECT guest_link_token FROM meeting WHERE id = $1`, p.MeetingID).Scan(&token)
		if token != nil {
			guestToken = *token
		} else {
			guestToken = gt
		}
	}

	url := fmt.Sprintf("%s/g/%s", w.baseURL, guestToken)
	when := "сейчас"
	if scheduledAt != nil {
		when = scheduledAt.Format("2 January 2006, 15:04")
	} else if startedAt != nil {
		when = startedAt.Format("2 January 2006, 15:04")
	}

	subject := "Приглашение на встречу: " + title
	body := buildInvitationHTML(title, hostName, when, url)

	sendErr := w.m.Send(ctx, mailer.Message{
		To:       []string{email},
		Subject:  subject,
		HTMLBody: body,
	})
	if sendErr != nil {
		// Запишем причину и оставим job'у уйти на ретрай (queue сама дёрнет с backoff).
		_, _ = w.db.Exec(ctx, `
			UPDATE meeting_invitation
			   SET attempts = attempts + 1, last_error = $2, status = 'failed'
			 WHERE id = $1
		`, p.InvitationID, sendErr.Error())
		return sendErr
	}

	if _, err := w.db.Exec(ctx, `
		UPDATE meeting_invitation
		   SET status = 'sent', sent_at = NOW(), attempts = attempts + 1, last_error = NULL
		 WHERE id = $1
	`, p.InvitationID); err != nil {
		return fmt.Errorf("mark sent: %w", err)
	}
	return nil
}

func buildInvitationHTML(title, host, when, url string) string {
	t := html.EscapeString(title)
	h := html.EscapeString(host)
	w := html.EscapeString(when)
	u := html.EscapeString(url)
	return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.5">` +
		`<div style="max-width:520px;margin:24px auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">` +
		`<h2 style="margin:0 0 12px;font-size:18px">Вас приглашают на встречу</h2>` +
		`<p style="margin:0 0 6px"><strong>` + t + `</strong></p>` +
		`<p style="margin:0 0 4px;color:#6b7280;font-size:13px">Когда: ` + w + `</p>` +
		(func() string {
			if h == "" {
				return ""
			}
			return `<p style="margin:0 0 16px;color:#6b7280;font-size:13px">Организатор: ` + h + `</p>`
		})() +
		`<p style="margin:16px 0"><a href="` + u + `" style="display:inline-block;background:#1E5AA8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Присоединиться</a></p>` +
		`<p style="margin:8px 0;color:#6b7280;font-size:12px">Если кнопка не работает, скопируйте ссылку:<br><span style="font-family:'DM Mono',monospace;color:#1f2937;word-break:break-all">` + u + `</span></p>` +
		`<p style="margin:24px 0 0;color:#9ca3af;font-size:11px">Это автоматическое сообщение от Toolkit.</p>` +
		`</div></body></html>`
}
