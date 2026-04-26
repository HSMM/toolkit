// Package queue is a Postgres-backed job queue using FOR UPDATE SKIP LOCKED.
// Reasoning: ТЗ MVP scale (≤100 users, ≤50 concurrent calls) is well within
// PG queue throughput; one less moving part than a Redis/RabbitMQ broker.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status mirrors the CHECK in the job table (migration 000002).
type Status string

const (
	StatusPending    Status = "pending"
	StatusRunning    Status = "running"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
	StatusDeadLetter Status = "dead_letter"
)

// Job is a row from the job table, decoded.
type Job struct {
	ID           int64
	Kind         string
	Payload      json.RawMessage
	Status       Status
	Priority     int
	Attempts     int
	MaxAttempts  int
	ScheduledAt  time.Time
	LockedAt     *time.Time
	LockedBy     string
	LastError    string
	CreatedAt    time.Time
	CompletedAt  *time.Time
}

// Queue is the public API for enqueueing and dequeuing jobs.
type Queue struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queue {
	return &Queue{pool: pool}
}

// Enqueue inserts a new job. priority is interpreted as "higher number runs
// first within the same scheduled_at"; default 0. delay is added to scheduled_at.
func (q *Queue) Enqueue(ctx context.Context, kind string, payload any, opts ...EnqueueOpt) (int64, error) {
	o := enqueueOpts{maxAttempts: 3, priority: 0}
	for _, fn := range opts {
		fn(&o)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("marshal payload: %w", err)
	}
	const ins = `
		INSERT INTO job (kind, payload, scheduled_at, priority, max_attempts)
		VALUES ($1, $2::jsonb, NOW() + ($3 || ' seconds')::interval, $4, $5)
		RETURNING id
	`
	var id int64
	delaySec := int(o.delay.Seconds())
	if err := q.pool.QueryRow(ctx, ins, kind, string(body), delaySec, o.priority, o.maxAttempts).Scan(&id); err != nil {
		return 0, fmt.Errorf("insert job: %w", err)
	}
	return id, nil
}

type enqueueOpts struct {
	delay       time.Duration
	priority    int
	maxAttempts int
}

// EnqueueOpt customises Enqueue.
type EnqueueOpt func(*enqueueOpts)

// WithDelay schedules the job to be picked no earlier than now+d.
func WithDelay(d time.Duration) EnqueueOpt { return func(o *enqueueOpts) { o.delay = d } }

// WithPriority sets the priority (higher → picked first, default 0).
func WithPriority(p int) EnqueueOpt { return func(o *enqueueOpts) { o.priority = p } }

// WithMaxAttempts sets the maximum number of attempts before dead-letter (default 3).
func WithMaxAttempts(n int) EnqueueOpt { return func(o *enqueueOpts) { o.maxAttempts = n } }

// Claim atomically picks one runnable job and marks it 'running'.
// Returns nil, nil when no job is currently available — caller polls.
//
// workerID identifies the runner instance (for observability).
func (q *Queue) Claim(ctx context.Context, workerID string) (*Job, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const sel = `
		SELECT id, kind, payload, status, priority, attempts, max_attempts,
		       scheduled_at, locked_at, COALESCE(locked_by, ''), COALESCE(last_error, ''),
		       created_at, completed_at
		FROM job
		WHERE status = 'pending' AND scheduled_at <= NOW()
		ORDER BY priority DESC, scheduled_at
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`
	job := &Job{}
	if err := tx.QueryRow(ctx, sel).Scan(
		&job.ID, &job.Kind, &job.Payload, &job.Status, &job.Priority,
		&job.Attempts, &job.MaxAttempts, &job.ScheduledAt, &job.LockedAt,
		&job.LockedBy, &job.LastError, &job.CreatedAt, &job.CompletedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("select job: %w", err)
	}

	const upd = `
		UPDATE job
		SET status = 'running', locked_at = NOW(), locked_by = $2, attempts = attempts + 1
		WHERE id = $1
	`
	if _, err := tx.Exec(ctx, upd, job.ID, workerID); err != nil {
		return nil, fmt.Errorf("lock job: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	job.Status = StatusRunning
	job.Attempts++
	now := time.Now()
	job.LockedAt = &now
	job.LockedBy = workerID
	return job, nil
}

// Complete marks the job done. Idempotent.
func (q *Queue) Complete(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE job SET status = 'completed', completed_at = NOW(), locked_at = NULL, locked_by = NULL WHERE id = $1`,
		id)
	return err
}

// Fail marks the job failed and either reschedules with backoff (if attempts < max)
// or moves to dead-letter.
func (q *Queue) Fail(ctx context.Context, id int64, runErr error) error {
	const upd = `
		UPDATE job
		SET
			status       = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
			scheduled_at = CASE WHEN attempts >= max_attempts THEN scheduled_at
			                    ELSE NOW() + (LEAST(POWER(2, attempts), 3600) || ' seconds')::interval END,
			locked_at    = NULL,
			locked_by    = NULL,
			last_error   = $2
		WHERE id = $1
	`
	_, err := q.pool.Exec(ctx, upd, id, truncateErr(runErr))
	return err
}

// Reschedule explicitly delays the job's next attempt (does NOT count as a failure).
func (q *Queue) Reschedule(ctx context.Context, id int64, delay time.Duration) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE job SET status = 'pending', scheduled_at = NOW() + ($2 || ' seconds')::interval,
		    locked_at = NULL, locked_by = NULL WHERE id = $1`,
		id, int(delay.Seconds()))
	return err
}

// Stats returns counts grouped by status (for the API dashboard).
func (q *Queue) Stats(ctx context.Context) (map[Status]int, error) {
	rows, err := q.pool.Query(ctx, `SELECT status, COUNT(*) FROM job GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[Status]int{}
	for rows.Next() {
		var s Status
		var c int
		if err := rows.Scan(&s, &c); err != nil {
			return nil, err
		}
		out[s] = c
	}
	return out, nil
}

// truncateErr cuts an error message to fit comfortably in TEXT (avoid runaway).
func truncateErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	const max = 4000
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
