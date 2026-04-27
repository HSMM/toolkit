// Admin API: только для пользователей с role=admin (бэк защищён RequireRole).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type AdminUser = {
  id: string;
  bitrix_id: string;
  email: string;
  full_name: string;
  phone?: string;
  department?: string;
  position?: string;
  avatar_url?: string;
  extension?: string;
  status: "active" | "blocked";
  is_admin: boolean;
  last_login_at?: string;
  created_at: string;
};

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin-users"],
    queryFn: ({ signal }) =>
      api<{ items: AdminUser[] }>("/api/v1/admin/users", { signal }).then((r) => r.items),
    staleTime: 30_000,
  });
}

export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; role: "admin" | "user" }) =>
      api<void>(`/api/v1/admin/users/${args.id}/role`, { method: "PUT", body: { role: args.role } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admin-users"] }); },
  });
}

export function useSetUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; status: "active" | "blocked" }) =>
      api<void>(`/api/v1/admin/users/${args.id}/status`, { method: "PUT", body: { status: args.status } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admin-users"] }); },
  });
}

// Запускает синхронизацию пользователей с Bitrix24 (фильтр active+employee).
// Backend идёт по webhook'у из BITRIX_SYNC_WEBHOOK_URL — если он не задан,
// вернётся 503 sync_not_configured.
export type BitrixSyncResult = {
  fetched: number;
  added: number;
  updated: number;
  reactivated: number;
  deactivated: number;
  skipped: number;
  errors?: string[];
};
export function useSyncBitrixUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<BitrixSyncResult>("/api/v1/admin/users/sync/bitrix", { method: "POST", body: {} }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admin-users"] }); },
  });
}
