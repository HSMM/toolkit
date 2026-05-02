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

export type MessengerProvider = "telegram" | "viber";

export type AdminMessengerAccount = {
  id: string;
  provider: MessengerProvider;
  provider_user_id?: string;
  display_name: string;
  account_label?: string;
  username?: string;
  phone_masked?: string;
  status: "connecting" | "connected" | "error" | "revoked";
  error_message?: string;
  owner_user_id: string;
  owner_name: string;
  owner_email: string;
  access_count: number;
  connected_at?: string;
  last_sync_at?: string;
  updated_at: string;
};

export type AdminMessengerAccessUser = {
  id: string;
  full_name: string;
  email: string;
  role: "owner" | "member";
  granted_at: string;
  granted_by?: string;
  department?: string;
  position?: string;
};

export function useAdminMessengerAccounts(provider?: MessengerProvider) {
  return useQuery({
    queryKey: ["admin-messenger-accounts", provider ?? "all"],
    queryFn: ({ signal }) =>
      api<{ items: AdminMessengerAccount[] }>(`/api/v1/admin/messenger/accounts${provider ? `?provider=${provider}` : ""}`, { signal }).then((r) => r.items),
    staleTime: 20_000,
  });
}

export function useAdminMessengerAccess(accountId?: string) {
  return useQuery({
    queryKey: ["admin-messenger-access", accountId],
    queryFn: ({ signal }) =>
      api<{ items: AdminMessengerAccessUser[] }>(`/api/v1/admin/messenger/accounts/${accountId}/access`, { signal }).then((r) => r.items),
    enabled: Boolean(accountId),
    staleTime: 10_000,
    placeholderData: [],
  });
}

export function useGrantMessengerAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { accountId: string; userId: string }) =>
      api<{ items: AdminMessengerAccessUser[] }>(`/api/v1/admin/messenger/accounts/${args.accountId}/access`, {
        method: "POST",
        body: { user_id: args.userId },
      }),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ["admin-messenger-access", args.accountId] });
      void qc.invalidateQueries({ queryKey: ["admin-messenger-accounts"] });
    },
  });
}

export function useRevokeMessengerAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { accountId: string; userId: string }) =>
      api<void>(`/api/v1/admin/messenger/accounts/${args.accountId}/access/${args.userId}`, { method: "DELETE" }),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ["admin-messenger-access", args.accountId] });
      void qc.invalidateQueries({ queryKey: ["admin-messenger-accounts"] });
    },
  });
}
