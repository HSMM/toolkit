import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type TelegramStatus = {
  configured: boolean;
  connected: boolean;
  sync_enabled: boolean;
  policy: {
    reuse_allowed: boolean;
    retention_days: number;
    sync_private_chats: boolean;
    sync_groups: boolean;
    sync_channels: boolean;
    initial_cache_limit: number;
  };
  account?: {
    id: string;
    display_name: string;
    username: string;
    phone_masked: string;
    status: "connecting" | "connected" | "error" | "revoked";
    error_message?: string;
    connected_at?: string;
    last_sync_at?: string;
  };
};

export type TelegramQrLogin = {
  login_id: string;
  status: "pending" | "confirmed" | "expired" | "error" | "password_required";
  qr_payload?: string;
  qr_image?: string;
  expires_at: string;
  error?: string;
  account?: TelegramStatus["account"];
};

export type TelegramChat = {
  id: string;
  provider_chat_id: string;
  type: "private" | "group" | "channel" | "bot" | "unknown";
  title: string;
  unread_count: number;
  last_message_preview: string;
  last_message_at?: string;
  muted: boolean;
  pinned: boolean;
};

export type TelegramMessage = {
  id: string;
  direction: "in" | "out";
  sender_name: string;
  text: string;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
  sent_at: string;
  attachments: Array<{
    id: string;
    kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker" | "unknown";
    file_name: string;
    mime_type: string;
    size_bytes?: number;
    width?: number;
    height?: number;
    duration_sec?: number;
    download_url: string;
  }>;
};

const STATUS_KEY = ["messenger", "telegram", "status"] as const;
const CHATS_KEY = ["messenger", "telegram", "chats"] as const;
const messagesKey = (chatId?: string) => ["messenger", "telegram", "messages", chatId] as const;

export function useTelegramStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => api<TelegramStatus>("/api/v1/messenger/telegram/status", { signal }),
    staleTime: 20_000,
  });
}

export function useTelegramChats(enabled: boolean) {
  return useQuery({
    queryKey: CHATS_KEY,
    queryFn: ({ signal }) => api<{ items: TelegramChat[]; next_cursor: string }>("/api/v1/messenger/telegram/chats", { signal }),
    enabled,
    staleTime: 10_000,
    placeholderData: { items: [], next_cursor: "" },
  });
}

export function useSyncTelegramChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ items: TelegramChat[]; synced_at: string }>("/api/v1/messenger/telegram/sync", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: CHATS_KEY });
    },
  });
}

export function useTelegramMessages(chatId?: string) {
  return useQuery({
    queryKey: messagesKey(chatId),
    queryFn: ({ signal }) => api<{ items: TelegramMessage[]; next_cursor: string }>(`/api/v1/messenger/telegram/chats/${chatId}/messages`, { signal }),
    enabled: Boolean(chatId),
    staleTime: 10_000,
    placeholderData: { items: [], next_cursor: "" },
  });
}

export function useSyncTelegramMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      api<{ items: TelegramMessage[]; next_cursor: string }>(`/api/v1/messenger/telegram/chats/${chatId}/sync`, { method: "POST" }),
    onSuccess: (_data, chatId) => {
      void qc.invalidateQueries({ queryKey: messagesKey(chatId) });
      void qc.invalidateQueries({ queryKey: CHATS_KEY });
    },
  });
}

export function useSendTelegramMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string; text: string; files?: File[] }) => {
      const files = input.files ?? [];
      const body = new FormData();
      body.append("text", input.text);
      files.forEach((file) => body.append("files", file, file.name));
      return api<{ items: TelegramMessage[] }>(`/api/v1/messenger/telegram/chats/${input.chatId}/messages`, {
        method: "POST",
        body: files.length > 0 ? body : { text: input.text },
      });
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: messagesKey(input.chatId) });
      void qc.invalidateQueries({ queryKey: CHATS_KEY });
    },
  });
}

export function useStartTelegramQrLogin() {
  return useMutation({
    mutationFn: () => api<TelegramQrLogin>("/api/v1/messenger/telegram/auth/qr/start", { method: "POST" }),
  });
}

export function useTelegramQrLogin(loginId?: string) {
  return useQuery({
    queryKey: ["messenger", "telegram", "qr", loginId],
    queryFn: ({ signal }) => api<TelegramQrLogin>(`/api/v1/messenger/telegram/auth/qr/${loginId}`, { signal }),
    enabled: Boolean(loginId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "confirmed" || status === "expired" || status === "error" || status === "password_required" ? false : 2500;
    },
  });
}

export function useDisconnectTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/v1/messenger/telegram/session", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: CHATS_KEY });
    },
  });
}
