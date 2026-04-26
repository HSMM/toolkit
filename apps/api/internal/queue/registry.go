package queue

import (
	"context"
	"fmt"
	"sync"
)

// HandlerFunc processes one job. Return error to fail (with retry/dead-letter).
// Return ErrSkip to drop the job without error or retry (rare; normally just
// log and return nil if the job is no longer relevant).
type HandlerFunc func(ctx context.Context, payload []byte) error

// ErrSkip — handler signals the job should be silently skipped (not retried).
type ErrSkip struct{ Reason string }

func (e *ErrSkip) Error() string { return "queue: skip: " + e.Reason }

// Registry maps job kind → handler. Safe for concurrent registration.
type Registry struct {
	mu       sync.RWMutex
	handlers map[string]HandlerFunc
}

func NewRegistry() *Registry {
	return &Registry{handlers: map[string]HandlerFunc{}}
}

// Register binds a handler to a kind. Panics on duplicate (programming error).
func (r *Registry) Register(kind string, h HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[kind]; exists {
		panic(fmt.Sprintf("queue: handler for %q already registered", kind))
	}
	r.handlers[kind] = h
}

// Handler returns the handler for a kind or nil if unregistered.
func (r *Registry) Handler(kind string) HandlerFunc {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.handlers[kind]
}

// Kinds returns the list of registered kinds (sorted, useful for diagnostics).
func (r *Registry) Kinds() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	return out
}
