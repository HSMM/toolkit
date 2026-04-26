// API клиент для модуля /api/v1/meetings (E5).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiFetch } from "./client";

export type Meeting = {
  id: string;
  created_by: string;
  title: string;
  description?: string;
  scheduled_at?: string;
  started_at?: string;
  ended_at?: string;
  livekit_room_id: string;
  record_enabled: boolean;
  auto_transcribe: boolean;
  has_external: boolean;
  recording_active?: boolean;
  recording_started_at?: string;
  created_at: string;
};

export type Participant = {
  id: string;
  meeting_id: string;
  user_id?: string;
  is_guest: boolean;
  external_name?: string;
  external_email?: string;
  livekit_identity: string;
  role: "host" | "participant" | "guest";
  admit_state: "pending" | "admitted" | "rejected";
  joined_at?: string;
  left_at?: string;
  display_name?: string;
};

export type JoinResult = {
  token: string;
  ws_url: string;
  room: string;
  identity: string;
  role: "host" | "participant" | "guest";
};

export type CreateMeetingInput = {
  title: string;
  description?: string;
  scheduled_at?: string; // RFC3339; пусто = instant
  record_enabled?: boolean;
  auto_transcribe?: boolean;
  participant_ids?: string[];
};

export function useMeetings() {
  return useQuery({
    queryKey: ["meetings"],
    queryFn: ({ signal }) =>
      api<{ items: Meeting[] }>("/api/v1/meetings", { signal }).then((r) => r.items),
    staleTime: 10_000,
  });
}

export function useMeeting(id: string | null) {
  return useQuery({
    queryKey: ["meeting", id],
    enabled: !!id,
    queryFn: ({ signal }) =>
      api<{ meeting: Meeting; participants: Participant[] }>(
        `/api/v1/meetings/${id}`, { signal }),
  });
}

export function useCreateMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMeetingInput) =>
      api<Meeting>("/api/v1/meetings", { method: "POST", body: input }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["meetings"] }); },
  });
}

export function useJoinMeeting() {
  return useMutation({
    mutationFn: (id: string) =>
      api<JoinResult>(`/api/v1/meetings/${id}/join`, { method: "POST" }),
  });
}

export function useEndMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/v1/meetings/${id}/end`, { method: "POST" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["meetings"] }); },
  });
}

export function useLeaveMeeting() {
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/v1/meetings/${id}/leave`, { method: "POST" }),
  });
}

export function useShareMeeting() {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ token: string }>(`/api/v1/meetings/${id}/share`, { method: "POST" }),
  });
}

// Поллит детальную карточку встречи (включая participants[]) —
// host использует для отслеживания pending-гостей.
export function useMeetingPoll(id: string | null, refetchMs = 3000) {
  return useQuery({
    queryKey: ["meeting", id],
    enabled: !!id,
    refetchInterval: refetchMs,
    queryFn: ({ signal }) =>
      api<{ meeting: Meeting; participants: Participant[] }>(`/api/v1/meetings/${id}`, { signal }),
  });
}

export function useStartRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      api<void>(`/api/v1/meetings/${meetingId}/recording/start`, { method: "POST" }),
    onSuccess: (_d, id) => { void qc.invalidateQueries({ queryKey: ["meeting", id] }); },
  });
}

export function useStopRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      api<void>(`/api/v1/meetings/${meetingId}/recording/stop`, { method: "POST" }),
    onSuccess: (_d, id) => { void qc.invalidateQueries({ queryKey: ["meeting", id] }); },
  });
}

export type RecordingFile = {
  id: string;
  kind: "meeting_composite" | "meeting_audio" | "meeting_per_track";
  mime_type: string;
  size_bytes: number;
  duration_ms: number;
  created_at: string;
  filename: string;
};

export function useMeetingRecordings(meetingId: string | null) {
  return useQuery({
    queryKey: ["meeting-recordings", meetingId],
    enabled: !!meetingId,
    queryFn: ({ signal }) =>
      api<{ items: RecordingFile[] }>(`/api/v1/meetings/${meetingId}/recordings`, { signal })
        .then((r) => r.items),
    staleTime: 15_000,
  });
}

// downloadMeetingRecording — фетчит файл через apiFetch (с JWT) и
// триггерит браузерный «Сохранить как».
export async function downloadMeetingRecording(meetingId: string, recordingId: string, suggestedName: string) {
  const r = await apiFetch(`/api/v1/meetings/${meetingId}/recordings/${recordingId}/download`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useAdmitGuest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { meetingId: string; participantId: string; allow: boolean }) =>
      api<void>(`/api/v1/meetings/${args.meetingId}/admit`, {
        method: "POST",
        body: { participant_id: args.participantId, allow: args.allow },
      }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ["meeting", vars.meetingId] }); },
  });
}
