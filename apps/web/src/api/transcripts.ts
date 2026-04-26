// Клиент API для модуля транскрибации.
// Соответствует apps/api/internal/transcription/handlers.go (E7).

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiFetch } from "./client";

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

export function useTranscripts(opts?: { meetingId?: string }) {
  const params = opts?.meetingId ? `?meeting=${encodeURIComponent(opts.meetingId)}` : "";
  return useQuery({
    queryKey: ["transcripts", opts?.meetingId ?? "all"],
    queryFn: ({ signal }) => api<{ items: Transcript[] }>(`/api/v1/transcripts${params}`, { signal }),
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

// ── Аналитика ──────────────────────────────────────────────────────────

export type EmotionDist = { angry: number; sad: number; neutral: number; positive: number };
export type ChannelEmotions = { channel: number; emotions: EmotionDist };
export type EmotionAnalysis = { overall?: EmotionDist; channels?: ChannelEmotions[] };

export type SpeakerStats = {
  speaker: string;
  label: string;
  talk_time_ms: number;
  talk_ratio_pct: number;
  segments: number;
  words: number;
};

export type WordCount = { word: string; count: number };

export type Analytics = {
  total_duration_ms: number;
  segment_count: number;
  word_count: number;
  char_count: number;
  speakers: SpeakerStats[];
  silence_total_ms: number;
  longest_silence_ms: number;
  silence_threshold_ms: number;
  interruptions: number;
  top_words: WordCount[];
  emotions?: EmotionAnalysis;
};

export function useTranscriptAnalytics(id: string | null) {
  return useQuery({
    queryKey: ["transcript-analytics", id],
    enabled: !!id,
    queryFn: ({ signal }) => api<Analytics>(`/api/v1/transcripts/${id}/analytics`, { signal }),
    staleTime: 60_000,
  });
}

// useAudioBlob — фетчит аудио через apiFetch (с JWT-bearer) и возвращает
// object URL для <audio src=>. Браузер не передаёт Authorization в <audio src>,
// поэтому полный download → blob URL.
export function useAudioBlob(transcriptId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!transcriptId) {
      setUrl(null); setError(null); setLoading(false);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true); setError(null);

    (async () => {
      try {
        const r = await apiFetch(`/api/v1/transcripts/${transcriptId}/audio`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "audio fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [transcriptId]);

  return { url, loading, error };
}

// downloadTxt — кликом по кнопке: фетчит TXT, создаёт временную ссылку.
export async function downloadTxt(transcriptId: string, suggestedName: string) {
  const r = await apiFetch(`/api/v1/transcripts/${transcriptId}/export.txt`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName.replace(/\.[^.]+$/, "") + ".txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// fetchTxt — для копирования в clipboard.
export async function fetchTxt(transcriptId: string): Promise<string> {
  const r = await apiFetch(`/api/v1/transcripts/${transcriptId}/export.txt`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

