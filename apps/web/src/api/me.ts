// Хелперы для эндпоинтов /api/v1. По мере расширения схемы (E2/E5/E6/E7/E8)
// сюда добавляются вызовы; типы — из сгенерированного schema.gen.ts (`npm run gen:api`).

import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type Me = {
  user_id: string;
  email: string;
  role: "user" | "admin";
  supervises: number;
  session_id: string;
  // Профиль из таблицы "user" (sync с Bitrix24)
  bitrix_id?: string;
  full_name?: string;
  phone?: string;
  department?: string;
  position?: string;
  avatar_url?: string;
  extension?: string;
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => api<Me>("/api/v1/me", { signal }),
  });
}
