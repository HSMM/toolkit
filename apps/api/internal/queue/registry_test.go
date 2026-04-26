package queue

import (
	"context"
	"errors"
	"sort"
	"testing"
)

func TestRegistry_RegisterAndLookup(t *testing.T) {
	r := NewRegistry()
	r.Register("a", func(ctx context.Context, payload []byte) error { return nil })
	r.Register("b", func(ctx context.Context, payload []byte) error { return errors.New("boom") })

	if h := r.Handler("a"); h == nil {
		t.Fatal("expected handler for a")
	}
	if h := r.Handler("missing"); h != nil {
		t.Fatal("expected nil for unregistered kind")
	}

	kinds := r.Kinds()
	sort.Strings(kinds)
	if len(kinds) != 2 || kinds[0] != "a" || kinds[1] != "b" {
		t.Errorf("unexpected kinds: %v", kinds)
	}
}

func TestRegistry_DuplicatePanics(t *testing.T) {
	r := NewRegistry()
	r.Register("dup", func(ctx context.Context, _ []byte) error { return nil })
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on duplicate registration")
		}
	}()
	r.Register("dup", func(ctx context.Context, _ []byte) error { return nil })
}

func TestErrSkip_ErrorIs(t *testing.T) {
	e1 := &ErrSkip{Reason: "stale"}
	if e1.Error() == "" {
		t.Fatal("expected non-empty error message")
	}
	wrapped := someWrap(e1)
	var got *ErrSkip
	if !errors.As(wrapped, &got) {
		t.Fatal("errors.As should find ErrSkip")
	}
	if got.Reason != "stale" {
		t.Errorf("Reason: got %q want stale", got.Reason)
	}
}

// someWrap mimics how a handler might wrap ErrSkip.
type wrapper struct{ inner error }

func (w *wrapper) Error() string { return "wrapped: " + w.inner.Error() }
func (w *wrapper) Unwrap() error { return w.inner }
func someWrap(e error) error     { return &wrapper{inner: e} }
