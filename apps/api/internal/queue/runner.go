package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// RunnerOptions tunes the worker pool.
type RunnerOptions struct {
	// Concurrency — number of jobs running in parallel.
	Concurrency int
	// PollInterval — how often to look for new jobs when idle. We use the
	// claim path (FOR UPDATE SKIP LOCKED) which is cheap; 1-2 sec is fine.
	PollInterval time.Duration
	// IdleSleep — extra delay after a poll returned nothing, to back off.
	IdleSleep time.Duration
	// JobTimeout — per-job context deadline.
	JobTimeout time.Duration
	// WorkerID — identifies this runner in job.locked_by (default: hostname:pid).
	WorkerID string
}

func (o *RunnerOptions) defaults() {
	if o.Concurrency <= 0 {
		o.Concurrency = 4
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 1 * time.Second
	}
	if o.IdleSleep <= 0 {
		o.IdleSleep = 2 * time.Second
	}
	if o.JobTimeout <= 0 {
		o.JobTimeout = 10 * time.Minute
	}
	if o.WorkerID == "" {
		host, _ := os.Hostname()
		o.WorkerID = fmt.Sprintf("%s:%d", host, os.Getpid())
	}
}

// Runner pulls jobs from a Queue and dispatches to handlers from a Registry.
type Runner struct {
	q        *Queue
	registry *Registry
	opts     RunnerOptions
	logger   *slog.Logger
}

func NewRunner(q *Queue, registry *Registry, logger *slog.Logger, opts RunnerOptions) *Runner {
	opts.defaults()
	return &Runner{q: q, registry: registry, logger: logger, opts: opts}
}

// Start launches the worker pool. Blocks until ctx is done; returns nil after
// graceful drain (in-flight jobs allowed to finish).
func (r *Runner) Start(ctx context.Context) error {
	r.logger.Info("queue runner starting",
		"concurrency", r.opts.Concurrency,
		"worker_id", r.opts.WorkerID,
		"kinds", r.registry.Kinds())

	jobs := make(chan *Job)
	var wg sync.WaitGroup

	for i := 0; i < r.opts.Concurrency; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			for job := range jobs {
				r.runOne(ctx, slot, job)
			}
		}(i)
	}

	r.poll(ctx, jobs)

	close(jobs)
	wg.Wait()
	r.logger.Info("queue runner stopped")
	return nil
}

func (r *Runner) poll(ctx context.Context, out chan<- *Job) {
	ticker := time.NewTicker(r.opts.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		// Drain available jobs in a tight inner loop to avoid waiting a full
		// PollInterval between consecutive jobs when the queue is non-empty.
		for {
			job, err := r.q.Claim(ctx, r.opts.WorkerID)
			if err != nil {
				r.logger.Error("queue claim failed", "err", err)
				time.Sleep(r.opts.IdleSleep)
				break
			}
			if job == nil {
				break // queue empty — wait for next tick
			}

			select {
			case out <- job:
			case <-ctx.Done():
				// shutting down — release the claim by failing it (will be retried)
				_ = r.q.Reschedule(context.Background(), job.ID, 0)
				return
			}
		}
	}
}

func (r *Runner) runOne(ctx context.Context, slot int, job *Job) {
	handler := r.registry.Handler(job.Kind)
	if handler == nil {
		r.logger.Error("no handler for kind", "kind", job.Kind, "job_id", job.ID)
		_ = r.q.Fail(context.Background(), job.ID, fmt.Errorf("no handler for kind %q", job.Kind))
		return
	}

	jobCtx, cancel := context.WithTimeout(ctx, r.opts.JobTimeout)
	defer cancel()

	start := time.Now()
	err := handler(jobCtx, []byte(job.Payload))
	dur := time.Since(start)

	logArgs := []any{
		"slot", slot,
		"job_id", job.ID,
		"kind", job.Kind,
		"attempt", job.Attempts,
		"duration_ms", dur.Milliseconds(),
	}

	switch {
	case err == nil:
		if cErr := r.q.Complete(context.Background(), job.ID); cErr != nil {
			r.logger.Error("complete failed", append(logArgs, "err", cErr)...)
			return
		}
		r.logger.Info("job done", logArgs...)
	default:
		var skip *ErrSkip
		if errors.As(err, &skip) {
			r.logger.Info("job skipped", append(logArgs, "reason", skip.Reason)...)
			_ = r.q.Complete(context.Background(), job.ID)
			return
		}
		if fErr := r.q.Fail(context.Background(), job.ID, err); fErr != nil {
			r.logger.Error("fail bookkeeping failed", append(logArgs, "err", fErr, "job_err", err)...)
			return
		}
		r.logger.Warn("job failed (will retry or dead-letter)", append(logArgs, "err", err)...)
	}
}
