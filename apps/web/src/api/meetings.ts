// API клиент для модуля /api/v1/meetings (E5).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

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
