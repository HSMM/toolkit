// Package ws is the WebSocket event channel from server to browser.
//
// Model: every connected client subscribes to events for a single user
// (their own user_id, derived from the JWT used to authenticate the WS
// upgrade). The hub broadcasts user-scoped events (e.g. "incoming_call",
// "transcript_ready") to all open sockets of that user across devices/tabs.
//
// In addition to per-user Publish, the hub supports per-role broadcast
// (PublishToRole) — used for events that should be delivered to every
// online admin (e.g. "phone_extension_request_created"). Roles are taken
// from the authenticated subject at WS upgrade time and indexed alongside
// userID; reconnect after role change is required to refresh the index.
package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// Event is what gets serialized as JSON to the client.
//
// Type — short string identifier ("incoming_call", "meeting_invited",
// "transcript_ready", "session_revoked", ...). Frontend matches on Type.
// Payload — domain-specific data, schema-by-type.
// IssuedAt — server timestamp; clients can detect drift.
type Event struct {
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	IssuedAt time.Time       `json:"issued_at"`
}

// client is a single open WebSocket. We never block the hub on a slow client;
// dropped events are logged.
type client struct {
	id     uuid.UUID
	userID uuid.UUID
	role   string
	conn   *websocket.Conn
	send   chan Event
	closed chan struct{}
}

// Hub multiplexes events to per-user subscribers. Safe for concurrent use.
type Hub struct {
	mu       sync.RWMutex
	clients  map[uuid.UUID]map[uuid.UUID]*client // userID -> connID -> client
	byRole   map[string]map[uuid.UUID]*client    // role  -> connID -> client
	logger   *slog.Logger
}

// NewHub constructs a Hub.
func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		clients: map[uuid.UUID]map[uuid.UUID]*client{},
		byRole:  map[string]map[uuid.UUID]*client{},
		logger:  logger,
	}
}

// register adds a new client. Returns the cleanup func.
func (h *Hub) register(c *client) func() {
	h.mu.Lock()
	if h.clients[c.userID] == nil {
		h.clients[c.userID] = map[uuid.UUID]*client{}
	}
	h.clients[c.userID][c.id] = c
	if c.role != "" {
		if h.byRole[c.role] == nil {
			h.byRole[c.role] = map[uuid.UUID]*client{}
		}
		h.byRole[c.role][c.id] = c
	}
	count := len(h.clients[c.userID])
	h.mu.Unlock()

	h.logger.Debug("ws client registered", "user_id", c.userID, "conn_id", c.id, "role", c.role, "user_total", count)

	return func() {
		h.mu.Lock()
		delete(h.clients[c.userID], c.id)
		if len(h.clients[c.userID]) == 0 {
			delete(h.clients, c.userID)
		}
		if c.role != "" && h.byRole[c.role] != nil {
			delete(h.byRole[c.role], c.id)
			if len(h.byRole[c.role]) == 0 {
				delete(h.byRole, c.role)
			}
		}
		h.mu.Unlock()
		close(c.closed)
		h.logger.Debug("ws client unregistered", "user_id", c.userID, "conn_id", c.id)
	}
}

// Publish broadcasts an event to every connection of the target user.
// Non-blocking: if a client's buffer is full the event is dropped for that
// client only (logged at warn level). The frontend should resync on reconnect.
func (h *Hub) Publish(target uuid.UUID, e Event) int {
	if e.IssuedAt.IsZero() {
		e.IssuedAt = time.Now().UTC()
	}
	h.mu.RLock()
	conns := h.clients[target]
	delivered := 0
	for _, c := range conns {
		select {
		case c.send <- e:
			delivered++
		default:
			h.logger.Warn("ws send buffer full, dropping event",
				"user_id", target, "conn_id", c.id, "event_type", e.Type)
		}
	}
	h.mu.RUnlock()
	return delivered
}

// PublishToRole broadcasts an event to every connected client with the given
// role. Non-blocking, same drop-on-full semantics as Publish. Empty role is
// a no-op.
//
// Note: role is captured at WS upgrade time. If a user's role changes
// (admin promote/demote), they must reconnect for the change to be picked
// up by this index.
func (h *Hub) PublishToRole(role string, e Event) int {
	if role == "" {
		return 0
	}
	if e.IssuedAt.IsZero() {
		e.IssuedAt = time.Now().UTC()
	}
	h.mu.RLock()
	conns := h.byRole[role]
	delivered := 0
	for _, c := range conns {
		select {
		case c.send <- e:
			delivered++
		default:
			h.logger.Warn("ws send buffer full on role broadcast",
				"role", role, "user_id", c.userID, "conn_id", c.id, "event_type", e.Type)
		}
	}
	h.mu.RUnlock()
	return delivered
}

// Broadcast sends an event to every connected user. Used for admin alerts
// (system maintenance) — rare; per-user Publish is the normal path.
func (h *Hub) Broadcast(e Event) int {
	if e.IssuedAt.IsZero() {
		e.IssuedAt = time.Now().UTC()
	}
	h.mu.RLock()
	delivered := 0
	for _, conns := range h.clients {
		for _, c := range conns {
			select {
			case c.send <- e:
				delivered++
			default:
				h.logger.Warn("ws send buffer full on broadcast",
					"user_id", c.userID, "conn_id", c.id, "event_type", e.Type)
			}
		}
	}
	h.mu.RUnlock()
	return delivered
}

// CountConnected returns the number of currently connected users (and total
// open sockets). For diagnostics / Prometheus metric.
func (h *Hub) CountConnected() (users, sockets int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conns := range h.clients {
		users++
		sockets += len(conns)
	}
	return
}

// pump runs the read+write loops for one client until close. Started by Handle.
func (h *Hub) pump(ctx context.Context, c *client) {
	// Writer
	go func() {
		ping := time.NewTicker(30 * time.Second)
		defer ping.Stop()
		for {
			select {
			case e, ok := <-c.send:
				if !ok {
					return
				}
				wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := writeJSON(wctx, c.conn, e)
				cancel()
				if err != nil {
					_ = c.conn.Close(websocket.StatusInternalError, "write failed")
					return
				}
			case <-ping.C:
				wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := c.conn.Ping(wctx)
				cancel()
				if err != nil {
					_ = c.conn.Close(websocket.StatusGoingAway, "ping failed")
					return
				}
			case <-c.closed:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	// Reader — discard everything; server is authoritative.
	for {
		_, _, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
	}
}

func writeJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	w, err := conn.Writer(ctx, websocket.MessageText)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}
