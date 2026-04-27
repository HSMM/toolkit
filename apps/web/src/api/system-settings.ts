import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type ModuleAccess = {
  vcs: boolean;
  transcription: boolean;
  messengers: boolean;
  contacts: boolean;
  helpdesk: boolean;
};

const ALL_ON: ModuleAccess = {
  vcs: true, transcription: true, messengers: true, contacts: true, helpdesk: true,
};

export function useModuleAccess() {
  return useQuery({
    queryKey: ["module-access"],
    queryFn: ({ signal }) =>
      api<ModuleAccess>("/api/v1/system-settings/modules", { signal }).catch(() => ALL_ON),
    staleTime: 30_000,
    // На любой ошибке — fall-back: показываем все модули, не блокируем UI.
    placeholderData: ALL_ON,
  });
}

export function useUpdateModuleAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ModuleAccess) =>
      api<ModuleAccess>("/api/v1/admin/system-settings/modules", { method: "PUT", body: v }),
    onSuccess: (data) => { qc.setQueryData(["module-access"], data); },
  });
}

// ─── SMTP ────────────────────────────────────────────────────────────────

export type SmtpConfigPublic = {
  host: string;
  port: number;
  encryption: "ssl" | "starttls" | "none" | "";
  user: string;
  has_password: boolean;
  from_name: string;
  from_email: string;
};

export type SmtpConfigInput = Omit<SmtpConfigPublic, "has_password"> & {
  password?: string; // если пусто — backend сохранит существующий
};

export function useSmtpConfig() {
  return useQuery({
    queryKey: ["smtp-config"],
    queryFn: ({ signal }) =>
      api<SmtpConfigPublic>("/api/v1/admin/system-settings/smtp", { signal }),
    staleTime: 30_000,
  });
}

export function useUpdateSmtpConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SmtpConfigInput) =>
      api<SmtpConfigPublic>("/api/v1/admin/system-settings/smtp", { method: "PUT", body: v }),
    onSuccess: (data) => { qc.setQueryData(["smtp-config"], data); },
  });
}
