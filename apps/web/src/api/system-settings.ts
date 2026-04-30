import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

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

// ─── Phone (FreePBX WebRTC) ──────────────────────────────────────────────

export type PhoneExtension = {
  ext: string;
  has_password: boolean;
  assigned_to?: string | null;
};
export type PhoneExtensionInput = {
  ext: string;
  password?: string;          // пусто → backend сохранит существующий
  assigned_to?: string | null;
};
export type PhoneConfigPublic = {
  wss_url: string;
  extensions: PhoneExtension[];
};
export type PhoneConfigInput = {
  wss_url: string;
  extensions: PhoneExtensionInput[];
};

export function usePhoneConfig() {
  return useQuery({
    queryKey: ["phone-config"],
    queryFn: ({ signal }) =>
      api<PhoneConfigPublic>("/api/v1/admin/system-settings/phone", { signal }),
    staleTime: 30_000,
  });
}

export function useUpdatePhoneConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: PhoneConfigInput) =>
      api<PhoneConfigPublic>("/api/v1/admin/system-settings/phone", { method: "PUT", body: v }),
    onSuccess: (data) => {
      qc.setQueryData(["phone-config"], data);
      // Креды текущего пользователя могли поменяться (новый extension/password) —
      // даём SoftphoneWidget шанс перерегистрироваться.
      void qc.invalidateQueries({ queryKey: ["my-phone-credentials"] });
    },
  });
}

// Креды текущего пользователя для браузерного софтфона. Возвращается 404
// если за пользователем не закреплён extension — это не ошибка, а нормальное
// "ещё не настроено" состояние.
export type MyPhoneCredentials = {
  wss_url: string;
  extension: string;
  password: string;
};
export function useMyPhoneCredentials() {
  return useQuery({
    queryKey: ["my-phone-credentials"],
    queryFn: ({ signal }) =>
      api<MyPhoneCredentials>("/api/v1/system-settings/phone/me", { signal })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
    staleTime: 60_000,
    retry: false,
  });
}

// ─── Telegram (MTProto) ──────────────────────────────────────────────────

export type TelegramConfigPublic = {
  api_id: number;
  has_api_hash: boolean;
  has_session_encryption_key: boolean;
  worker_url: string;
  sync_enabled: boolean;
  retention_days: number;
  configured: boolean;
};

export type TelegramConfigInput = {
  api_id: number;
  api_hash?: string;
  session_encryption_key?: string;
  worker_url: string;
  sync_enabled: boolean;
  retention_days: number;
  generate_encryption_key?: boolean;
};

export function useTelegramConfig() {
  return useQuery({
    queryKey: ["telegram-config"],
    queryFn: ({ signal }) =>
      api<TelegramConfigPublic>("/api/v1/admin/system-settings/telegram", { signal }),
    staleTime: 30_000,
  });
}

export function useUpdateTelegramConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: TelegramConfigInput) =>
      api<TelegramConfigPublic>("/api/v1/admin/system-settings/telegram", { method: "PUT", body: v }),
    onSuccess: (data) => {
      qc.setQueryData(["telegram-config"], data);
      void qc.invalidateQueries({ queryKey: ["messenger", "telegram", "status"] });
    },
  });
}
