package transcription

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/HSMM/toolkit/internal/auth"
)

// Handlers — REST-эндпоинты модуля транскрибации.
type Handlers struct {
	svc *Service
}

func NewHandlers(svc *Service) *Handlers { return &Handlers{svc: svc} }

// Routes — chi-роутер, монтируется под /api/v1/transcripts.
func (h *Handlers) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/upload", h.upload)
	r.Get("/{id}", h.get)
	r.Post("/{id}/retry", h.retry)
	r.Delete("/{id}", h.delete)
	r.Get("/{id}/audio", h.audio)
	r.Get("/{id}/export.txt", h.exportTxt)
	r.Get("/{id}/analytics", h.analytics)
	return r
}

func (h *Handlers) upload(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())

	// Лимит размера запроса (multipart-форма) — c небольшим запасом.
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadBytes+8*1024*1024)

	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_multipart", err.Error())
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "no_file", "form field 'file' is required")
		return
	}
	defer file.Close()

	res, err := h.svc.Upload(r.Context(), UploadInput{
		UploaderID:  subj.UserID,
		Filename:    header.Filename,
		ContentType: header.Header.Get("Content-Type"),
		Size:        header.Size,
		Body:        file,
	})
	if err != nil {
		h.svc.Logger().Warn("transcript upload failed",
			"err", err,
			"filename", header.Filename,
			"content_type", header.Header.Get("Content-Type"),
			"size", header.Size,
			"user_id", subj.UserID,
		)
		status := http.StatusInternalServerError
		msg := err.Error()
		if strings.Contains(msg, "unsupported file extension") ||
			strings.Contains(msg, "file too large") ||
			strings.Contains(msg, "empty uploader id") {
			status = http.StatusBadRequest
		}
		writeErr(w, status, "upload_failed", msg)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"transcript_id": res.TranscriptID,
		"recording_id":  res.RecordingID,
		"status":        StatusQueued,
	})
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	var meetingFilter *uuid.UUID
	if mq := r.URL.Query().Get("meeting"); mq != "" {
		mid, err := uuid.Parse(mq)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_meeting_id", "invalid meeting uuid")
			return
		}
		meetingFilter = &mid
	}
	items, err := h.svc.ListByUser(r.Context(), subj.UserID, 100, meetingFilter)
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
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	view, err := h.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "transcript not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "get_failed", err.Error())
		return
	}
	// Проверка доступа: владелец upload'а или admin.
	if !subj.IsAdmin() && view.UploadedBy != subj.UserID {
		writeErr(w, http.StatusForbidden, "forbidden", "")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (h *Handlers) retry(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	view, err := h.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "lookup_failed", err.Error())
		return
	}
	if !subj.IsAdmin() && view.UploadedBy != subj.UserID {
		writeErr(w, http.StatusForbidden, "forbidden", "")
		return
	}
	if err := h.svc.Retry(r.Context(), id); err != nil {
		if errors.Is(err, ErrNotRetryable) {
			writeErr(w, http.StatusConflict, "not_retryable", "transcript not in failed/partial state")
			return
		}
		writeErr(w, http.StatusInternalServerError, "retry_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": StatusQueued})
}

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	if err := h.svc.Delete(r.Context(), id, subj.UserID); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "transcript not found or not yours")
			return
		}
		writeErr(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// audio — стримит исходное аудио из MinIO с поддержкой Range
// (нужно для <audio> seek в браузере).
func (h *Handlers) audio(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	view, err := h.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "lookup", err.Error())
		return
	}
	if !subj.IsAdmin() && view.UploadedBy != subj.UserID {
		writeErr(w, http.StatusForbidden, "forbidden", "")
		return
	}

	if err := h.svc.StreamAudio(r.Context(), w, r, view); err != nil {
		h.svc.Logger().Warn("audio stream failed", "err", err, "transcript_id", id)
	}
}

// exportTxt — текст расшифровки в плоском txt.
func (h *Handlers) exportTxt(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	view, err := h.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "lookup", err.Error())
		return
	}
	if !subj.IsAdmin() && view.UploadedBy != subj.UserID {
		writeErr(w, http.StatusForbidden, "forbidden", "")
		return
	}

	body := buildTextExport(view)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(view.Filename)+`.txt"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

// analytics — статистика по сегментам (talk time per channel, ratio, silence, top words).
func (h *Handlers) analytics(w http.ResponseWriter, r *http.Request) {
	subj := auth.MustSubject(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "invalid uuid")
		return
	}
	view, err := h.svc.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "lookup", err.Error())
		return
	}
	if !subj.IsAdmin() && view.UploadedBy != subj.UserID {
		writeErr(w, http.StatusForbidden, "forbidden", "")
		return
	}
	writeJSON(w, http.StatusOK, computeAnalytics(view))
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
