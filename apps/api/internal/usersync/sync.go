// Package usersync — синхронизация пользователей из Bitrix24 в локальный
// "user" table. Использует OAuth-токены админских сессий (refresh_token хранится
// в session.bitrix_refresh_token_encrypted, base64), не требует webhook.
package usersync

import (
	"context"
	"encoding/base64"
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
// 'deactivated_in_bitrix'. Идемпотентно. Использует свежий access_token,
// полученный refresh'ем токена самой свежей активной admin-сессии.
func Run(ctx context.Context, db *pgxpool.Pool, client *bitrix.Client) (Result, error) {
	res := Result{}
	accessToken, err := refreshAdminToken(ctx, db, client)
	if err != nil {
		return res, err
	}

	seenBitrix := map[string]bool{}
	start := 0
	for {
		page, next, err := client.ListEmployees(ctx, accessToken, start)
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

// refreshAdminToken берёт самую свежую активную admin-сессию с непустым
// bitrix_refresh_token, обменивает refresh на access, перезаписывает
// refresh обратно (он одноразовый), возвращает access_token.
func refreshAdminToken(ctx context.Context, db *pgxpool.Pool, client *bitrix.Client) (string, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	const findQ = `
		SELECT s.id, s.bitrix_refresh_token_encrypted
		  FROM session s
		  JOIN role_assignment ra ON ra.user_id = s.user_id AND ra.role = 'admin'
		 WHERE s.revoked_at IS NULL
		   AND s.bitrix_refresh_token_encrypted IS NOT NULL
		   AND s.bitrix_refresh_token_encrypted <> ''
		 ORDER BY s.last_used_at DESC
		 LIMIT 1
		 FOR UPDATE
	`
	var sessionID string
	var encoded string
	if err := tx.QueryRow(ctx, findQ).Scan(&sessionID, &encoded); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("нет активной admin-сессии с bitrix-токеном; войдите как админ через Bitrix24 и повторите")
		}
		return "", fmt.Errorf("найти admin-сессию: %w", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("decode refresh token: %w", err)
	}

	tok, err := client.RefreshAccessToken(ctx, string(raw), "")
	if err != nil {
		return "", err
	}

	// Сохраняем новый refresh обратно — старый больше не валиден.
	newEncoded := base64.StdEncoding.EncodeToString([]byte(tok.RefreshToken))
	if _, err := tx.Exec(ctx,
		`UPDATE session SET bitrix_refresh_token_encrypted = $1 WHERE id = $2`,
		newEncoded, sessionID,
	); err != nil {
		return "", fmt.Errorf("save new refresh: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tok.AccessToken, nil
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
		// Синтетический не пускает в систему через OAuth, но запись будет видна
		// в селекторе приглашений.
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
