package ws

import (
	"net/http"
	"strings"

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

	// Echo back any "bearer.<token>" subprotocol браузер прислал в handshake'е,
	// иначе библиотека выберет пустой subprotocol и Chrome/Safari закроют WS
	// со статусом 1006. Сами субпротоколы в payload не используем — это просто
	// способ доставить JWT через WS-handshake (header нельзя выставить из JS).
	var subprotocols []string
	if proto := r.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		for _, p := range strings.Split(proto, ",") {
			p = strings.TrimSpace(p)
			if strings.HasPrefix(p, "bearer.") {
				subprotocols = append(subprotocols, p)
			}
		}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:     h.allowedOrigins,
		InsecureSkipVerify: len(h.allowedOrigins) == 0,
		Subprotocols:       subprotocols,
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
