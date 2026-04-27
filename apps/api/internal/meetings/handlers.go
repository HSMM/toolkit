package meetings

import (
	"encoding/json"
	"errors"
	"fmt"
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
	r.Post("/{id}/admit", h.admit) // host решает по pending-гостям
	r.Post("/{id}/recording/start", h.recordingStart)
	r.Post("/{id}/recording/stop", h.recordingStop)
	r.Get("/{id}/recordings", h.recordingsList)
	r.Get("/{id}/recordings/{recId}/download", h.recordingDownload)
	return r
}

// GuestRoutes монтируются под /api/v1/guests — публичные, без auth-middleware.
func (h *Handlers) GuestRoutes() http.Handler {
	r := chi.NewRouter()
	r.Get("/{token}", h.guestLookup)
	r.Post("/{token}/request", h.guestRequest)         // создать pending-заявку
	r.Get("/{token}/status/{requestID}", h.guestStatus) // long-poll: pending|admitted|rejected|ended
	return r
}

type createReq struct {
	Title          string      `json:"title"`
	Description    string      `json:"description"`
	ScheduledAt    *time.Time  `json:"scheduled_at,omitempty"`
	RecordEnabled  bool        `json:"record_enabled"`
	AutoTranscribe bool        `json:"auto_transcribe"`
	ParticipantIDs []uuid.UUID `json:"participant_ids,omitempty"`
	InviteeEmails  []string    `json:"invitee_emails,omitempty"`
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
		InviteeEmails:  req.InviteeEmails,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

// SearchUsers — отдельный публичный handler, монтируется НЕ под /meetings,
// а как /api/v1/users/search (auth-only). Используется multi-select'ом
// в диалоге создания встречи.
func (h *Handlers) SearchUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := 0 // service подставит default
	if v := r.URL.Query().Get("limit"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &limit)
	}
	users, err := h.svc.SearchUsers(r.Context(), q, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users})
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

type guestRequestReq struct {
	DisplayName string `json:"display_name"`
}

func (h *Handlers) guestRequest(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	var req guestRequestReq
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
			return
		}
	}
	id, err := h.svc.GuestRequestEntry(r.Context(), tok, req.DisplayName)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"request_id": id})
}

func (h *Handlers) guestStatus(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	rid, err := uuid.Parse(chi.URLParam(r, "requestID"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid request id")
		return
	}
	st, err := h.svc.GuestPollStatus(r.Context(), tok, rid)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

type admitReq struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Allow         bool      `json:"allow"`
}

func (h *Handlers) admit(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	var req admitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if req.ParticipantID == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "bad_pid", "participant_id required")
		return
	}
	if err := h.svc.AdmitGuest(r.Context(), subj, id, req.ParticipantID, req.Allow); err != nil {
		writeServiceErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) recordingStart(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	if err := h.svc.StartRecording(r.Context(), subj, id); err != nil {
		if errors.Is(err, ErrRecordingNotConfigured) {
			writeErr(w, http.StatusServiceUnavailable, "recording_unavailable", err.Error())
			return
		}
		writeServiceErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Handlers) recordingsList(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	items, err := h.svc.ListRecordings(r.Context(), subj, id)
	if err != nil {
		writeServiceErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handlers) recordingDownload(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	mid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	rid, err := uuid.Parse(chi.URLParam(r, "recId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_rec_id", "invalid recording id")
		return
	}
	if err := h.svc.StreamRecording(r.Context(), subj, w, r, mid, rid); err != nil {
		// Если headers ещё не выписаны — отдадим JSON. Если уже стримили — просто выйдем.
		if errors.Is(err, ErrRecordingNotConfigured) {
			writeErr(w, http.StatusServiceUnavailable, "recording_unavailable", err.Error())
			return
		}
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
			writeServiceErr(w, err)
			return
		}
		writeErr(w, http.StatusInternalServerError, "stream_failed", err.Error())
	}
}

func (h *Handlers) recordingStop(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid meeting id")
		return
	}
	if err := h.svc.StopRecording(r.Context(), subj, id); err != nil {
		if errors.Is(err, ErrRecordingNotConfigured) {
			writeErr(w, http.StatusServiceUnavailable, "recording_unavailable", err.Error())
			return
		}
		writeServiceErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
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
