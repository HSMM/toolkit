// Admin API: только для пользователей с role=admin (бэк защищён RequireRole).
import { useQuery } from "@tanstack/react-query";
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
