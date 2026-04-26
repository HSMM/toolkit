// Клиент API для модуля транскрибации.
// Соответствует apps/api/internal/transcription/handlers.go (E7).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type TranscriptStatus =
  | "pending" | "queued" | "processing"
  | "completed" | "partial" | "failed";

export type TranscriptSegment = {
  id: string;
  segment_no: number;
  speaker_ref: string;
  start_ms: number;
  end_ms: number;
  text: string;
  is_edited: boolean;
  version: number;
};

export type Transcript = {
  id: string;
  recording_id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
  status: TranscriptStatus;
  engine: string;
  engine_version?: string;
  gigaam_task_id?: string;
  execution_time_ms?: number;
  error_message?: string;
  attempts: number;
  completed_at?: string | null;
  segments?: TranscriptSegment[];
};

// ────────────────────────────────────────────────────────────────────

export function useTranscripts() {
  return useQuery({
    queryKey: ["transcripts"],
    queryFn: ({ signal }) => api<{ items: Transcript[] }>("/api/v1/transcripts", { signal }),
    // Polling: пока есть незаконченные транскрипты — освежаем список.
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const busy = items.some((t: Transcript) =>
        t.status === "queued" || t.status === "processing" || t.status === "pending"
      );
      return busy ? 3_000 : false;
    },
  });
}

export function useTranscript(id: string | null) {
  return useQuery({
    queryKey: ["transcript", id],
    enabled: !!id,
    queryFn: ({ signal }) => api<Transcript>(`/api/v1/transcripts/${id}`, { signal }),
    refetchInterval: (q) => {
      const t = q.state.data;
      if (!t) return false;
      return (t.status === "queued" || t.status === "processing") ? 3_000 : false;
    },
  });
}

export function useUploadTranscript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ transcript_id: string; recording_id: string; status: TranscriptStatus }>(
        "/api/v1/transcripts/upload",
        { method: "POST", body: fd },
      );
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["transcripts"] }); },
  });
}

export function useRetryTranscript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/v1/transcripts/${id}/retry`, { method: "POST" }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: ["transcripts"] });
      void qc.invalidateQueries({ queryKey: ["transcript", id] });
    },
  });
}

export function useDeleteTranscript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/v1/transcripts/${id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["transcripts"] }); },
  });
}

