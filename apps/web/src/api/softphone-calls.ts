import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { CallDirection, HistoryItem } from "@/components/softphone/types";

export type SoftphoneCallLogItem = {
  id: string;
  direction: CallDirection;
  number: string;
  timestamp: string;
  duration_sec?: number;
  status: "answered" | "missed" | "failed" | "cancelled" | "ended";
  reason?: string;
};

export type CreateSoftphoneCallLogInput = {
  session_id: string;
  direction: CallDirection;
  number: string;
  timestamp: string;
  duration_sec?: number;
  status: SoftphoneCallLogItem["status"];
  reason?: string;
};

const QUERY_KEY = ["softphone-call-history"] as const;

export function useSoftphoneCallHistory(extension?: string) {
  return useQuery({
    queryKey: [...QUERY_KEY, extension ?? "unassigned"],
    queryFn: ({ signal }) => api<{ items: SoftphoneCallLogItem[] }>("/api/v1/phone/calls", { signal }),
    enabled: Boolean(extension),
    staleTime: 20_000,
    select: (data) => data.items.map(toHistoryItem),
    placeholderData: { items: [] },
  });
}

export function useCreateSoftphoneCallLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSoftphoneCallLogInput) =>
      api<SoftphoneCallLogItem>("/api/v1/phone/calls", { method: "POST", body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useDeleteSoftphoneCallLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/v1/phone/calls/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useClearSoftphoneCallLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/v1/phone/calls", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

function toHistoryItem(item: SoftphoneCallLogItem): HistoryItem {
  return {
    id: item.id,
    direction: item.direction,
    number: item.number,
    timestamp: new Date(item.timestamp).getTime(),
    durationSec: item.duration_sec,
  };
}
