package meetings

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/HSMM/toolkit/internal/auth"
)

type Handlers struct{ svc *Service }

func NewHandlers(svc *Service) *Handlers { return &Handlers{svc: svc} }

// Routes монтируются под /api/v1/meetings (RequireAuth).
func (h *Handlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/", h.create)
	r.Get("/{id}", h.get)
	r.Post("/{id}/join", h.join)
	r.Post("/{id}/leave", h.leave)
	r.Post("/{id}/end", h.end)
	r.Post("/{id}/share", h.share)
	return r
}

// GuestRoutes монтируются под /api/v1/guests — публичные, без auth-middleware.
func (h *Handlers) GuestRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/{token}", h.guestLookup)
	r.Post("/{token}/join", h.guestJoin)
	return r
}

type createReq struct {
	Title          string      `json:"title"`
	Description    string      `json:"description"`
	ScheduledAt    *time.Time  `json:"scheduled_at,omitempty"`
	RecordEnabled  bool        `json:"record_enabled"`
	AutoTranscribe bool        `json:"auto_transcribe"`
	ParticipantIDs []uuid.UUID `json:"participant_ids,omitempty"`
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	m, err := h.svc.Create(r.Context(), CreateInput{
		CreatorID:      subj.UserID,
		Title:          req.Title,
		Description:    req.Description,
		ScheduledAt:    req.ScheduledAt,
		RecordEnabled:  req.RecordEnabled,
		AutoTranscribe: req.AutoTranscribe,
		ParticipantIDs: req.ParticipantIDs,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	items, err := h.svc.List(r.Context(), subj.UserID, 100)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	m, parts, err := h.svc.Get(r.Context(), subj, id)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"meeting": m, "participants": parts})
}

func (h *Handlers) join(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	res, err := h.svc.Join(r.Context(), subj, id)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *Handlers) leave(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	if err := h.svc.Leave(r.Context(), subj.UserID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "leave_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) end(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	if err := h.svc.End(r.Context(), subj, id); err != nil {
		writeServiceErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) share(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	tok, err := h.svc.EnsureGuestLink(r.Context(), subj, id)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tok})
}

func (h *Handlers) guestLookup(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	info, err := h.svc.GuestLookup(r.Context(), tok)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

type guestJoinReq struct {
	DisplayName string `json:"display_name"`
}

func (h *Handlers) guestJoin(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	var req guestJoinReq
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
	}
	res, err := h.svc.GuestJoin(r.Context(), tok, req.DisplayName)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": errCode, "message": message},
	})
}

func writeServiceErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden", err.Error())
	case errors.Is(err, ErrEnded):
		writeErr(w, http.StatusConflict, "ended", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}
