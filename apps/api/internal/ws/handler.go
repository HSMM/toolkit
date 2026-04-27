package ws

import (
	"net/http"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/HSMM/toolkit/internal/auth"
)

// Handler is the HTTP handler registered at /api/v1/ws.
// Auth: requires RequireAuth middleware in front of it (subject in ctx).
type Handler struct {
	hub             *Hub
	allowedOrigins  []string
	sendBufferSize  int
}

// NewHandler builds a WS endpoint. allowedOrigins must include the SPA origin
// (e.g. "toolkit.example.com"); empty list disables origin check (dev only).
func NewHandler(hub *Hub, allowedOrigins []string) *Handler {
	return &Handler{
		hub:            hub,
		allowedOrigins: allowedOrigins,
		sendBufferSize: 32,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	subj := auth.FromContext(r.Context())
	if subj == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:    h.allowedOrigins,
		InsecureSkipVerify: len(h.allowedOrigins) == 0,
	})
	if err != nil {
		// Accept already wrote a response on failure.
		return
	}

	c := &client{
		id:     uuid.New(),
		userID: subj.UserID,
		role:   string(subj.Role),
		conn:   conn,
		send:   make(chan Event, h.sendBufferSize),
		closed: make(chan struct{}),
	}
	cleanup := h.hub.register(c)
	defer cleanup()

	// Greet the client so it can confirm subscription.
	c.send <- Event{Type: "ws.connected"}

	h.hub.pump(r.Context(), c)
	_ = conn.Close(websocket.StatusNormalClosure, "")
}
