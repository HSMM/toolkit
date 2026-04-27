// Заявки пользователей на закрепление внутреннего номера (extension'а).
// Backend: apps/api/internal/phonereq.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

export type PhoneExtensionRequestStatus =
  | "pending" | "approved" | "rejected" | "cancelled";

export type PhoneExtensionRequest = {
  id: string;
  user_id: string;
  status: PhoneExtensionRequestStatus;
  comment?: string;
  reject_reason?: string;
  assigned_extension?: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
};

// ─── User side ───────────────────────────────────────────────────────────

// useMyExtensionRequest — последняя заявка текущего пользователя или null.
// Backend возвращает {request: {...} | null}.
export function useMyExtensionRequest() {
  return useQuery({
    queryKey: ["my-extension-request"],
    queryFn: ({ signal }) =>
      api<{ request: PhoneExtensionRequest | null }>(
        "/api/v1/phone/extension-requests/me",
        { signal },
      ).then((r) => r.request),
    staleTime: 30_000,
  });
}

export function useCreateExtensionRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { comment?: string }) =>
      api<PhoneExtensionRequest>("/api/v1/phone/extension-requests/", {
        method: "POST",
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["my-extension-request"], data);
    },
  });
}

export function useCancelMyExtensionRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<void>("/api/v1/phone/extension-requests/me", { method: "DELETE" }),
    onSuccess: () => {
      // Заявка теперь cancelled — перезапросим, чтобы UI обновился.
      void qc.invalidateQueries({ queryKey: ["my-extension-request"] });
    },
  });
}

// ─── Admin side ──────────────────────────────────────────────────────────

export type AdminPhoneExtensionRequest = PhoneExtensionRequest & {
  user: {
    id: string;
    full_name: string;
    email: string;
    department?: string;
    position?: string;
  };
  resolved_by_name?: string;
};

export type AdminListResponse = {
  items: AdminPhoneExtensionRequest[];
  total: number;
  pending_count: number;
};

export type AdminListFilter = "pending" | "history" | "all";

export function useAdminExtensionRequests(filter: AdminListFilter = "pending") {
  return useQuery({
    queryKey: ["admin-extension-requests", filter],
    queryFn: ({ signal }) =>
      api<AdminListResponse>(
        `/api/v1/admin/phone/extension-requests/?status=${filter}`,
        { signal },
      ),
    staleTime: 15_000,
  });
}

export function useApproveExtensionRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; ext: string; password?: string }) =>
      api<AdminPhoneExtensionRequest>(
        `/api/v1/admin/phone/extension-requests/${input.id}/approve`,
        { method: "POST", body: { ext: input.ext, password: input.password } },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-extension-requests"] });
      // phone_config поменялся — может появиться новый extension и/или
      // занятая привязка → у других страниц инвалидируем.
      void qc.invalidateQueries({ queryKey: ["phone-config"] });
      void qc.invalidateQueries({ queryKey: ["my-phone-credentials"] });
    },
  });
}

export function useRejectExtensionRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      api<AdminPhoneExtensionRequest>(
        `/api/v1/admin/phone/extension-requests/${input.id}/reject`,
        { method: "POST", body: { reason: input.reason } },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-extension-requests"] });
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Распаковка кода ошибки от backend'а — для inline-сообщений в формах.
export function extensionRequestErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) return e.code;
  return null;
}
