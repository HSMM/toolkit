import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type Colleague = {
  id: string;
  bitrix_id: string;
  email: string;
  full_name: string;
  phone?: string;
  department?: string;
  position?: string;
  avatar_url?: string;
  extension?: string;
  last_login_at: string;
};

export function useColleagues() {
  return useQuery({
    queryKey: ["colleagues"],
    queryFn: ({ signal }) =>
      api<{ items: Colleague[] }>("/api/v1/colleagues", { signal }).then((r) => r.items),
    staleTime: 30_000,
  });
}
