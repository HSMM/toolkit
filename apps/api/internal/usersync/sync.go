// Package usersync — синхронизация пользователей из Bitrix24 в локальный
// "user" table. Запускается админом вручную из UI и (опционально) фоновым job'ом.
package usersync

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/HSMM/toolkit/internal/bitrix"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Result — отчёт по одному прогону sync.
type Result struct {
	Fetched     int      `json:"fetched"`     // всего получено из Bitrix
	Added       int      `json:"added"`       // вставлено новых
	Updated     int      `json:"updated"`     // изменено существующих
	Reactivated int      `json:"reactivated"` // вернулись в Bitrix после deactivated
	Deactivated int      `json:"deactivated"` // ранее активные, теперь отсутствуют в Bitrix
	Skipped     int      `json:"skipped"`     // без имени — нельзя сохранить
	Errors      []string `json:"errors,omitempty"`
}

// Run выполняет полную синхронизацию: тянет всех employee+active из Bitrix
// постранично, UPSERT'ит локальный "user", помечает missing'ов как
// 'deactivated_in_bitrix'. Идемпотентно.
func Run(ctx context.Context, db *pgxpool.Pool, client *bitrix.Client, webhookURL string) (Result, error) {
	res := Result{}
	if strings.TrimSpace(webhookURL) == "" {
		return res, fmt.Errorf("BITRIX_SYNC_WEBHOOK_URL не настроен")
	}

	seenBitrix := map[string]bool{}
	start := 0
	for {
		page, next, err := client.ListEmployees(ctx, webhookURL, start)
		if err != nil {
			return res, fmt.Errorf("page start=%d: %w", start, err)
		}
		for i := range page {
			u := &page[i]
			if u.ID == "" {
				continue
			}
			seenBitrix[u.ID] = true
			outcome, err := upsertOne(ctx, db, u)
			if err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("bitrix_id=%s: %v", u.ID, err))
				continue
			}
			res.Fetched++
			switch outcome {
			case "added":
				res.Added++
			case "updated":
				res.Updated++
			case "reactivated":
				res.Reactivated++
			case "skipped":
				res.Skipped++
			}
		}
		if next <= 0 || next == start {
			break
		}
		start = next
	}

	// Помечаем как deactivated тех, кого больше нет в Bitrix.
	deact, err := markMissing(ctx, db, seenBitrix)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("mark_missing: %v", err))
	}
	res.Deactivated = deact
	return res, nil
}

// upsertOne возвращает: "added" | "updated" | "reactivated" | "skipped".
func upsertOne(ctx context.Context, db *pgxpool.Pool, u *bitrix.User) (string, error) {
	fullName := u.FullName()
	if fullName == "" {
		return "skipped", nil
	}
	email := strings.TrimSpace(strings.ToLower(u.Email))
	if email == "" {
		// Bitrix позволяет учётки без email; нам он нужен (уникальный индекс).
		// Синтетический не пускает в систему через OAuth (нет почты в Bitrix-
		// ответе при login), но запись будет видна в селекторе приглашений.
		email = fmt.Sprintf("bx-%s@no-email.local", u.ID)
	}

	// CTE: prev — старая запись (если была), upd — UPSERT с RETURNING.
	const q = `
		WITH prev AS (
		    SELECT status FROM "user" WHERE bitrix_id = $1
		),
		upd AS (
		    INSERT INTO "user"
		        (bitrix_id, email, full_name, phone, department, position,
		         avatar_url, status, deleted_in_bx24)
		    VALUES ($1, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''),
		            NULLIF($7,''), 'active', FALSE)
		    ON CONFLICT (bitrix_id) DO UPDATE SET
		        email           = EXCLUDED.email,
		        full_name       = EXCLUDED.full_name,
		        phone           = EXCLUDED.phone,
		        department      = EXCLUDED.department,
		        position        = EXCLUDED.position,
		        avatar_url      = EXCLUDED.avatar_url,
		        deleted_in_bx24 = FALSE,
		        status = CASE
		            WHEN "user".status = 'deactivated_in_bitrix' THEN 'active'
		            ELSE "user".status
		        END
		    RETURNING (xmax = 0) AS inserted
		)
		SELECT upd.inserted, COALESCE(prev.status, '') FROM upd LEFT JOIN prev ON TRUE
	`
	var inserted bool
	var prevStatus string
	err := db.QueryRow(ctx, q,
		u.ID, email, fullName, u.Phone(), u.Department(),
		strings.TrimSpace(u.WorkPosition), strings.TrimSpace(u.PersonalPhoto),
	).Scan(&inserted, &prevStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("upsert returned no rows")
		}
		return "", err
	}
	switch {
	case inserted:
		return "added", nil
	case prevStatus == "deactivated_in_bitrix":
		return "reactivated", nil
	default:
		return "updated", nil
	}
}

// markMissing — для тех, кого нет в Bitrix-выгрузке: status='deactivated_in_bitrix',
// deleted_in_bx24=true. Возвращает количество затронутых строк.
func markMissing(ctx context.Context, db *pgxpool.Pool, seen map[string]bool) (int, error) {
	if len(seen) == 0 {
		// Защита от случайного "обнуления" если sync не получил ни одной страницы.
		return 0, nil
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	tag, err := db.Exec(ctx, `
		UPDATE "user"
		   SET status = 'deactivated_in_bitrix', deleted_in_bx24 = TRUE
		 WHERE NOT (bitrix_id = ANY($1))
		   AND status = 'active'
	`, ids)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
