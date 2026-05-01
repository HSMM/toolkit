import { AlertTriangle, Check, Download, FileText, FlaskConical, Image as ImageIcon, Loader2, MessageSquare, Monitor, Paperclip, RefreshCw, Search, Send, ShieldCheck, Smartphone, Trash2, Unplug, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "@/api/client";
import {
  type TelegramChat,
  type TelegramMessage,
  useDisconnectTelegram,
  useDisconnectViber,
  useSendTelegramMessage,
  useStartTelegramQrLogin,
  useStartViberLogin,
  useSyncTelegramChats,
  useSyncTelegramMessages,
  useSyncViberChats,
  useTelegramChats,
  useTelegramMessages,
  useTelegramQrLogin,
  useTelegramStatus,
  useViberLogin,
  useViberStatus,
} from "@/api/messenger";
import { C } from "@/styles/tokens";
import { useWsEvent } from "@/ws/useWs";

export function MessengerPage() {
  const status = useTelegramStatus();
  const connected = Boolean(status.data?.connected);
  const chats = useTelegramChats(connected);
  const syncChats = useSyncTelegramChats();
  const syncMessages = useSyncTelegramMessages();
  const sendMessage = useSendTelegramMessage();
  const startQr = useStartTelegramQrLogin();
  const disconnect = useDisconnectTelegram();
  const [loginId, setLoginId] = useState<string | undefined>();
  const [selectedChatId, setSelectedChatId] = useState<string | undefined>();
  const [chatSearch, setChatSearch] = useState("");
  const [provider, setProvider] = useState<"telegram" | "viber">("telegram");
  const autoSyncStarted = useRef(false);
  const qr = useTelegramQrLogin(loginId);
  const allChats = chats.data?.items ?? [];
  const normalizedSearch = chatSearch.trim().toLowerCase();
  const visibleChats = normalizedSearch
    ? allChats.filter((chat) =>
      chat.title.toLowerCase().includes(normalizedSearch) ||
      chat.last_message_preview.toLowerCase().includes(normalizedSearch) ||
      chat.type.toLowerCase().includes(normalizedSearch))
    : allChats;
  const selectedChat = allChats.find((chat) => chat.id === selectedChatId);
  const messages = useTelegramMessages(selectedChatId);

  const qrError = startQr.error instanceof ApiError ? startQr.error : null;

  useWsEvent<{ chat_id?: string }>("messenger.message.created", (event) => {
    if (event.payload?.chat_id && event.payload.chat_id === selectedChatId) {
      void messages.refetch();
    }
    void chats.refetch();
  });

  useEffect(() => {
    if (startQr.data?.login_id) setLoginId(startQr.data.login_id);
  }, [startQr.data?.login_id]);

  useEffect(() => {
    if (qr.data?.status === "confirmed") {
      void status.refetch();
      void chats.refetch();
    }
  }, [chats, qr.data?.status, status]);

  useEffect(() => {
    if (!connected || chats.isLoading || syncChats.isPending || autoSyncStarted.current) return;
    if ((chats.data?.items.length ?? 0) > 0) return;
    autoSyncStarted.current = true;
    syncChats.mutate();
  }, [chats.data?.items.length, chats.isLoading, connected, syncChats]);

  useEffect(() => {
    if (!selectedChatId || syncMessages.isPending) return;
    syncMessages.mutate(selectedChatId);
  }, [selectedChatId]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      if (document.hidden || syncChats.isPending) return;
      syncChats.mutate();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [connected, syncChats]);

  useEffect(() => {
    if (!selectedChatId) return;
    const timer = window.setInterval(() => {
      if (document.hidden || syncMessages.isPending) return;
      syncMessages.mutate(selectedChatId);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [selectedChatId, syncMessages]);

  return (
    <div style={{ height: "100%", background: "#f4f7f9", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 20px", background: "#ffffff", borderBottom: "1px solid #dbe3ea", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
            <MessageSquare size={20} color="#229ed9" />
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, color: C.text }}>Мессенджеры</h1>
          </div>
          <div style={{ fontSize: 13, color: C.text2 }}>Telegram MTProto и экспериментальный Viber user-client внутри Toolkit</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "inline-flex", padding: 3, borderRadius: 9, background: "#edf3f7", border: "1px solid #dbe3ea" }}>
            <ProviderTab active={provider === "telegram"} onClick={() => setProvider("telegram")}>Telegram</ProviderTab>
            <ProviderTab active={provider === "viber"} onClick={() => setProvider("viber")}>Viber PoC</ProviderTab>
          </div>
          {provider === "telegram" && (
            <button
              onClick={() => {
                void status.refetch();
                if (connected) syncChats.mutate();
                else void chats.refetch();
              }}
              disabled={syncChats.isPending}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 12px", borderRadius: 8, border: "1px solid #dbe3ea", background: "#ffffff", color: "#52616f", fontWeight: 600 }}
            >
              <RefreshCw size={14} className={syncChats.isPending ? "lk-spin" : undefined} />{syncChats.isPending ? "Синхронизация…" : "Обновить"}
            </button>
          )}
        </div>
      </div>

      {provider === "viber" ? (
        <ViberPocPanel />
      ) : status.isLoading ? (
        <Centered><Loader2 size={26} style={{ animation: "lk-pulse 1s infinite" }} />Загружаем Telegram…</Centered>
      ) : status.isError ? (
        <Centered tone="err"><AlertTriangle size={26} />Не удалось загрузить статус Telegram</Centered>
      ) : !status.data?.configured ? (
        <SetupRequired />
      ) : !connected ? (
        <ConnectTelegram
          pending={startQr.isPending}
          login={qr.data ?? startQr.data}
          errorCode={qrError?.code}
          errorMessage={qrError?.message}
          onStart={() => startQr.mutate()}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "360px minmax(0, 1fr)" }}>
          <aside style={{ borderRight: "1px solid #dbe3ea", background: "#ffffff", minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid #dbe3ea", display: "flex", alignItems: "center", gap: 11 }}>
              <ChatAvatar title={status.data.account?.display_name || "Telegram"} id={status.data.account?.id || "account"} size={42} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{status.data.account?.display_name || "Telegram"}</div>
                <div style={{ marginTop: 3, fontSize: 12, color: "#6b7a88", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {status.data.account?.username ? `@${status.data.account.username}` : status.data.account?.phone_masked || "Подключено"}
                </div>
              </div>
            </div>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid #edf2f6" }}>
              <div style={{ height: 36, borderRadius: 18, background: "#f1f5f8", display: "flex", alignItems: "center", gap: 8, padding: "0 11px", color: "#7b8794" }}>
                <Search size={16} />
                <input
                  value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)}
                  placeholder="Поиск"
                  style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "#17212b", fontSize: 13.5, fontFamily: "inherit" }}
                />
                {chatSearch && (
                  <button onClick={() => setChatSearch("")} aria-label="Очистить поиск" style={{ width: 24, height: 24, border: "none", borderRadius: 12, background: "transparent", color: "#7b8794", display: "grid", placeItems: "center", cursor: "pointer", padding: 0 }}>
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {allChats.length === 0 ? (
                <div style={{ padding: 18, color: C.text2, fontSize: 13, lineHeight: 1.55 }}>
                  Чаты пока не синхронизированы. Нажмите «Обновить», чтобы подтянуть личные чаты и группы из Telegram.
                  {syncChats.isError && (
                    <div style={{ marginTop: 10, color: C.err }}>
                      Не удалось синхронизировать: {syncChats.error instanceof Error ? syncChats.error.message : String(syncChats.error)}
                    </div>
                  )}
                </div>
              ) : visibleChats.length === 0 ? (
                <div style={{ padding: 18, color: "#6b7a88", fontSize: 13, lineHeight: 1.55 }}>
                  Ничего не найдено. Попробуйте другое название чата или фрагмент сообщения.
                </div>
              ) : visibleChats.map((chat) => {
                const active = selectedChatId === chat.id;
                return (
                <button
                  key={chat.id}
                  onClick={() => setSelectedChatId(chat.id)}
                  style={{
                    width: "100%",
                    minHeight: 72,
                    padding: "9px 12px",
                    border: "none",
                    borderBottom: "1px solid #edf2f6",
                    background: active ? "#d8efff" : "#ffffff",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <ChatAvatar title={chat.title} id={chat.provider_chat_id || chat.id} size={48} />
                  <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#17212b", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{chat.title}</span>
                      {chat.last_message_at && <span style={{ fontSize: 11, color: "#7b8794", flexShrink: 0 }}>{formatChatTime(chat.last_message_at)}</span>}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, color: "#6b7a88", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{chat.last_message_preview || "Нет сообщений"}</span>
                      {chat.unread_count > 0 && (
                        <span style={{ minWidth: 19, height: 19, padding: "0 6px", borderRadius: 10, background: "#35b36a", color: "white", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {chat.unread_count > 99 ? "99+" : chat.unread_count}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                );
              })}
            </div>
          </aside>
          <ChatPanel
            chat={selectedChat}
            loading={messages.isLoading || syncMessages.isPending}
            error={messages.error || syncMessages.error}
            messages={messages.data?.items ?? []}
            onRefresh={() => selectedChatId && syncMessages.mutate(selectedChatId)}
            onSend={(text, files) => selectedChatId && sendMessage.mutate({ chatId: selectedChatId, text, files })}
            sending={sendMessage.isPending}
            sendError={sendMessage.error}
            onDisconnect={() => disconnect.mutate()}
          />
        </div>
      )}
    </div>
  );
}

function ProviderTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        minWidth: 94,
        padding: "7px 11px",
        borderRadius: 7,
        border: "none",
        background: active ? "#ffffff" : "transparent",
        color: active ? "#17212b" : "#6b7a88",
        boxShadow: active ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none",
        fontWeight: 700,
        fontSize: 13,
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ViberPocPanel() {
  const status = useViberStatus();
  const startLogin = useStartViberLogin();
  const disconnect = useDisconnectViber();
  const syncChats = useSyncViberChats();
  const [loginId, setLoginId] = useState<string | undefined>();
  const login = useViberLogin(loginId);
  const loginData = login.data ?? startLogin.data;
  const workerError = startLogin.error instanceof Error ? startLogin.error.message : status.data?.error;

  useEffect(() => {
    if (startLogin.data?.login_id) setLoginId(startLogin.data.login_id);
  }, [startLogin.data?.login_id]);

  useEffect(() => {
    if (login.data?.status === "confirmed" || login.data?.status === "manual_action_required" || login.data?.status === "desktop_manual_action_required") {
      void status.refetch();
    }
  }, [login.data?.status, status]);

  return (
    <main style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24 }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(320px, 0.95fr)", gap: 16 }}>
        <section style={{ background: "#ffffff", border: "1px solid #dbe3ea", borderRadius: 10, padding: 18, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
                <FlaskConical size={20} color={C.warn} />
                <h2 style={{ margin: 0, fontSize: 18, color: C.text }}>Viber · Desktop PoC</h2>
              </div>
              <div style={{ color: C.text2, fontSize: 13, lineHeight: 1.55 }}>
                Пользовательский Viber-клиент запускается через отдельный worker. Telegram при этом не затрагивается.
              </div>
            </div>
            <span style={{ padding: "6px 10px", borderRadius: 999, background: C.warnBg, border: `1px solid ${C.warnBrd}`, color: C.warnTx, fontSize: 12, fontWeight: 750 }}>
              {status.data?.connected ? "сессия запущена" : "experimental"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <ViberStatusCard icon={<Check size={18} />} title="Worker" text={status.isLoading ? "Проверяем доступность..." : status.data?.configured ? "Доступен через API Toolkit." : "Не настроен."} tone={status.data?.configured ? "ok" : "warn"} />
            <ViberStatusCard icon={<Monitor size={18} />} title="Режим" text={status.data?.session?.mode || status.data?.mode || "desktop/browser gate"} tone="info" />
            <ViberStatusCard icon={<FlaskConical size={18} />} title="Чаты" text="Sync/send endpoints готовы, но чтение DOM ждёт стабильный Desktop target." tone="warn" />
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => startLogin.mutate()}
              disabled={startLogin.isPending}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 8, border: "none", background: C.acc, color: "white", fontWeight: 750 }}
            >
              {startLogin.isPending ? <Loader2 size={15} className="lk-spin" /> : <Smartphone size={15} />}
              Подключить Viber
            </button>
            <button
              onClick={() => syncChats.mutate()}
              disabled={syncChats.isPending || !status.data?.connected}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 8, border: "1px solid #dbe3ea", background: "#ffffff", color: status.data?.connected ? "#52616f" : "#94a3b8", fontWeight: 700 }}
            >
              <RefreshCw size={15} className={syncChats.isPending ? "lk-spin" : undefined} />
              Синхронизировать чаты
            </button>
            <button
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending || !status.data?.connected}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.errBrd}`, background: "#ffffff", color: status.data?.connected ? C.err : "#94a3b8", fontWeight: 700 }}
            >
              <Unplug size={15} />
              Отключить Viber
            </button>
          </div>

          {(workerError || loginData?.error || syncChats.error) && (
            <div style={{ borderRadius: 8, border: `1px solid ${C.warnBrd}`, background: C.warnBg, color: C.warnTx, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5 }}>
              {syncChats.error instanceof Error ? syncChats.error.message : loginData?.error || workerError}
            </div>
          )}

          <div style={{ borderRadius: 9, background: "#f8fbfd", border: "1px solid #dbe3ea", padding: 14, display: "grid", gap: 10 }}>
            <ViberMilestone done label="Кнопка подключения" detail="Frontend вызывает /api/v1/messenger/viber/auth/start от имени текущего пользователя." />
            <ViberMilestone done label="Прокси через API" detail="Browser не ходит в worker напрямую; Toolkit API прокидывает account_id = user_id." />
            <ViberMilestone done={Boolean(status.data?.connected)} label="Сессия worker" detail={status.data?.session?.title || status.data?.session?.url || "После подключения здесь появится статус runtime."} />
            <ViberMilestone label="Список чатов" detail="Endpoint уже есть; фактическое наполнение зависит от Desktop selectors/noVNC bridge." />
            <ViberMilestone label="Сообщения и отправка" detail="Контракты готовы, реализация включается после чтения списка чатов." />
          </div>
        </section>

        <section style={{ minHeight: 520, background: "#ffffff", border: "1px solid #dbe3ea", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "13px 15px", borderBottom: "1px solid #dbe3ea", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>Окно входа Viber</div>
              <div style={{ color: C.text2, fontSize: 12, marginTop: 2 }}>{loginData?.status || (status.data?.connected ? "running" : "не запущено")}</div>
            </div>
            {login.isFetching && <Loader2 size={16} className="lk-spin" color={C.text2} />}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", background: "#eef2f7", padding: 14 }}>
            {loginData?.qr_image ? (
              <img src={loginData.qr_image} alt="QR-код Viber" style={{ maxWidth: "100%", width: 260, borderRadius: 10, background: "#ffffff", border: "1px solid #dbe3ea" }} />
            ) : loginData?.screenshot ? (
              <img src={loginData.screenshot} alt="Окно входа Viber" style={{ maxWidth: "100%", maxHeight: 470, borderRadius: 10, background: "#ffffff", border: "1px solid #dbe3ea", objectFit: "contain" }} />
            ) : (
              <div style={{ textAlign: "center", maxWidth: 300, color: C.text2, fontSize: 13, lineHeight: 1.55 }}>
                <Smartphone size={34} color={C.text3} style={{ marginBottom: 12 }} />
                <div style={{ color: C.text, fontWeight: 750, marginBottom: 6 }}>Нажмите «Подключить Viber»</div>
                <div>Здесь появится QR или screenshot runtime-сессии.</div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ViberStatusCard({ icon, title, text, tone }: { icon: ReactNode; title: string; text: string; tone: "ok" | "warn" | "info" }) {
  const colors = tone === "ok"
    ? { bg: C.okBg, brd: C.ok, tx: C.ok }
    : tone === "warn"
      ? { bg: C.warnBg, brd: C.warnBrd, tx: C.warnTx }
      : { bg: "#eef6ff", brd: "#bfdbfe", tx: "#2563eb" };
  return (
    <div style={{ minHeight: 126, borderRadius: 9, border: `1px solid ${colors.brd}`, background: colors.bg, padding: 14, display: "grid", alignContent: "start", gap: 9 }}>
      <div style={{ width: 34, height: 34, borderRadius: 17, background: "#ffffff", color: colors.tx, display: "grid", placeItems: "center" }}>{icon}</div>
      <div style={{ color: C.text, fontSize: 14, fontWeight: 750 }}>{title}</div>
      <div style={{ color: C.text2, fontSize: 12.5, lineHeight: 1.45 }}>{text}</div>
    </div>
  );
}

function ViberMilestone({ done, label, detail }: { done?: boolean; label: string; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, color: C.text }}>
      <span style={{ width: 20, height: 20, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, marginTop: 1, background: done ? C.okBg : "#eef2f7", color: done ? C.ok : "#64748b" }}>
        {done ? <Check size={13} /> : <Loader2 size={12} />}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 750 }}>{label}</span>
        <span style={{ display: "block", marginTop: 2, fontSize: 12, color: C.text2, overflowWrap: "anywhere" }}>{detail}</span>
      </span>
    </div>
  );
}

function ChatPanel({
  chat,
  loading,
  error,
  messages,
  onRefresh,
  onSend,
  sending,
  sendError,
  onDisconnect,
}: {
  chat?: TelegramChat;
  loading: boolean;
  error: unknown;
  messages: TelegramMessage[];
  onRefresh: () => void;
  onSend: (text: string, files: File[]) => void;
  sending: boolean;
  sendError: unknown;
  onDisconnect: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canSend = (draft.trim().length > 0 || files.length > 0) && !sending;

  const submit = () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    onSend(text, files);
    setDraft("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (!chat) {
    return (
      <main style={{ minHeight: 0, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <Send size={34} color={C.text3} style={{ marginBottom: 14 }} />
          <h2 style={{ margin: "0 0 8px", color: C.text, fontSize: 18 }}>Выберите чат</h2>
          <p style={{ margin: 0, color: C.text2, fontSize: 13, lineHeight: 1.6 }}>
            После выбора чата здесь появится переписка.
          </p>
          <button
            onClick={onDisconnect}
            style={{ marginTop: 18, display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.errBrd}`, background: C.errBg, color: C.err, fontWeight: 650 }}
          >
            <Unplug size={14} />Отключить Telegram
          </button>
        </div>
      </main>
    );
  }

  const ordered = [...messages].sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
  return (
    <main style={{ minHeight: 0, display: "flex", flexDirection: "column", background: "#dcecf5" }}>
      <div style={{ padding: "10px 16px", background: "#ffffff", borderBottom: "1px solid #dbe3ea", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
          <ChatAvatar title={chat.title} id={chat.provider_chat_id || chat.id} size={42} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 750, color: "#17212b", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{chat.title}</div>
            <div style={{ marginTop: 2, fontSize: 12, color: "#6b7a88" }}>{chat.type === "group" ? "Группа" : "Личный чат"}</div>
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 11px", borderRadius: 8, border: "1px solid #dbe3ea", background: "#ffffff", color: "#52616f", fontWeight: 600 }}
        >
          <RefreshCw size={14} className={loading ? "lk-spin" : undefined} />Обновить
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px min(7vw, 82px)", display: "flex", flexDirection: "column", gap: 7 }}>
        {error ? (
          <div style={{ color: C.err, background: C.errBg, border: `1px solid ${C.errBrd}`, borderRadius: 8, padding: 12, fontSize: 13 }}>
            Не удалось открыть чат: {error instanceof Error ? error.message : String(error)}
          </div>
        ) : loading && ordered.length === 0 ? (
          <div style={{ display: "grid", placeItems: "center", height: "100%", color: C.text2, gap: 10 }}>
            <Loader2 size={24} className="lk-spin" />Загружаем сообщения…
          </div>
        ) : ordered.length === 0 ? (
          <div style={{ display: "grid", placeItems: "center", height: "100%", color: C.text2, fontSize: 13 }}>
            В этом чате пока нет сохранённых сообщений.
          </div>
        ) : ordered.map((message) => {
          const own = message.direction === "out";
          return (
            <div key={message.id} style={{ display: "flex", justifyContent: own ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "68%", padding: "8px 10px 6px", borderRadius: own ? "12px 12px 3px 12px" : "12px 12px 12px 3px", background: own ? "#effdde" : "#ffffff", color: "#17212b", boxShadow: "0 1px 1px rgba(15, 23, 42, 0.08)", fontSize: 13.5, lineHeight: 1.42, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {message.attachments.length > 0 && (
                  <div style={{ display: "grid", gap: 7, marginBottom: message.text ? 7 : 0 }}>
                    {message.attachments.map((attachment) => (
                      <AttachmentView key={attachment.id} attachment={attachment} />
                    ))}
                  </div>
                )}
                {message.text && <div>{message.text}</div>}
                {!message.text && message.attachments.length === 0 && "Сообщение без текста"}
                <div style={{ marginTop: 4, fontSize: 10.5, color: "#7b8794", textAlign: "right" }}>
                  {new Date(message.sent_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {Boolean(sendError) && (
        <div style={{ padding: "8px 14px 0", background: C.card, color: C.err, fontSize: 12 }}>
          Не удалось отправить: {sendError instanceof Error ? sendError.message : String(sendError)}
        </div>
      )}
      <div style={{ padding: "10px 14px 11px", background: "#ffffff", borderTop: "1px solid #dbe3ea", display: "grid", gap: 8 }}>
        {files.length > 0 && (
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {files.map((file, index) => (
              <div key={`${file.name}-${file.size}-${index}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, maxWidth: 260, padding: "7px 9px", borderRadius: 10, background: "#f1f5f8", border: "1px solid #dbe3ea", color: "#52616f", fontSize: 12 }}>
                {file.type.startsWith("image/") ? <ImageIcon size={15} /> : <FileText size={15} />}
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                <span style={{ color: "#8a98a8", flexShrink: 0 }}>{formatBytes(file.size)}</span>
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                  aria-label="Убрать файл"
                  style={{ width: 20, height: 20, border: "none", background: "transparent", color: "#7b8794", display: "grid", placeItems: "center", padding: 0, cursor: "pointer" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => {
            const next = Array.from(e.target.files ?? []);
            setFiles((prev) => [...prev, ...next].slice(0, 10));
          }}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          aria-label="Прикрепить файл"
          title="Прикрепить файл"
          style={{ width: 40, height: 40, borderRadius: 20, border: "1px solid #dbe3ea", background: "#ffffff", color: "#52616f", display: "grid", placeItems: "center", flexShrink: 0 }}
        >
          <Paperclip size={17} />
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Напишите сообщение..."
          style={{ flex: 1, minWidth: 0, padding: "10px 13px", borderRadius: 18, border: "1px solid #dbe3ea", background: "#ffffff", color: "#17212b", fontFamily: "inherit", fontSize: 13.5, outline: "none" }}
        />
        <button
          disabled={!canSend}
          onClick={submit}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 18, border: "none", background: canSend ? "#229ed9" : "#e8eef3", color: canSend ? "white" : "#8a98a8", fontWeight: 700 }}
        >
          {sending ? <Loader2 size={14} className="lk-spin" /> : <Send size={14} />}Отправить
        </button>
        </div>
      </div>
    </main>
  );
}

function AttachmentView({ attachment }: { attachment: TelegramMessage["attachments"][number] }) {
  const [objectUrl, setObjectUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(attachment.kind === "photo" || attachment.kind === "video" || attachment.kind === "audio" || attachment.kind === "voice");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    const shouldPreview = attachment.kind === "photo" || attachment.kind === "video" || attachment.kind === "audio" || attachment.kind === "voice";
    if (!shouldPreview) return undefined;
    setLoading(true);
    apiFetch(attachment.download_url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
        setError(undefined);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.download_url, attachment.kind]);

  const download = async () => {
    const res = await apiFetch(`${attachment.download_url}?disposition=attachment`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.file_name || "telegram-attachment";
    link.click();
    URL.revokeObjectURL(url);
  };

  if (attachment.kind === "photo" && objectUrl) {
    return (
      <button onClick={download} style={{ border: "none", padding: 0, background: "transparent", cursor: "pointer", textAlign: "left" }}>
        <img src={objectUrl} alt={attachment.file_name || "Фото"} style={{ display: "block", maxWidth: 320, maxHeight: 260, borderRadius: 10, objectFit: "cover" }} />
      </button>
    );
  }
  if ((attachment.kind === "video") && objectUrl) {
    return <video src={objectUrl} controls style={{ display: "block", maxWidth: 340, maxHeight: 260, borderRadius: 10, background: "#0f172a" }} />;
  }
  if ((attachment.kind === "audio" || attachment.kind === "voice") && objectUrl) {
    return <audio src={objectUrl} controls style={{ width: 280, maxWidth: "100%" }} />;
  }
  return (
    <button onClick={download} style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 210, maxWidth: 330, padding: 9, borderRadius: 10, border: "1px solid #dbe3ea", background: "#f8fbfd", color: "#17212b", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
      {loading ? <Loader2 size={18} className="lk-spin" /> : attachment.kind === "photo" ? <ImageIcon size={18} /> : <FileText size={18} />}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.file_name || attachmentLabel(attachment.kind)}</span>
        <span style={{ display: "block", marginTop: 2, fontSize: 11, color: error ? C.err : "#6b7a88" }}>{error || [attachmentLabel(attachment.kind), formatBytes(attachment.size_bytes)].filter(Boolean).join(" · ")}</span>
      </span>
      <Download size={16} />
    </button>
  );
}

function ChatAvatar({ title, id, size }: { title: string; id: string; size: number }) {
  const bg = avatarColor(id || title);
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: "50%",
      background: bg,
      color: "white",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: Math.max(12, Math.round(size * 0.36)),
      fontWeight: 800,
      flexShrink: 0,
      boxShadow: "inset 0 -10px 18px rgba(0,0,0,0.08)",
    }}>
      {initials(title)}
    </div>
  );
}

function initials(title: string) {
  const clean = title.trim().replace(/^@/, "");
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] || ""}${parts[1]![0] || ""}`.toUpperCase();
}

function avatarColor(seed: string) {
  const palette = [
    "linear-gradient(135deg, #5aa9f6, #2481cc)",
    "linear-gradient(135deg, #6bd189, #2ca85f)",
    "linear-gradient(135deg, #ffb35c, #f07b2f)",
    "linear-gradient(135deg, #b18cff, #7b61ff)",
    "linear-gradient(135deg, #ff7aa8, #e54273)",
    "linear-gradient(135deg, #57d3c2, #159b91)",
    "linear-gradient(135deg, #f87171, #dc2626)",
    "linear-gradient(135deg, #94a3b8, #64748b)",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

function formatChatTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function attachmentLabel(kind: string) {
  switch (kind) {
    case "photo": return "Фото";
    case "video": return "Видео";
    case "audio": return "Аудио";
    case "voice": return "Голосовое";
    case "sticker": return "Стикер";
    default: return "Файл";
  }
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

function SetupRequired() {
  return (
    <Centered>
      <ShieldCheck size={30} color={C.warn} />
      <span style={{ color: C.text, fontWeight: 650 }}>Telegram не настроен администратором</span>
      <span style={{ maxWidth: 440, color: C.text2, fontSize: 13, lineHeight: 1.6 }}>
        Нужно задать `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` на backend. Это MTProto-интеграция, не Bot API.
      </span>
    </Centered>
  );
}

function ConnectTelegram({
  pending,
  login,
  errorCode,
  errorMessage,
  onStart,
}: {
  pending: boolean;
  login?: { status: string; qr_image?: string; qr_payload?: string; error?: string };
  errorCode?: string;
  errorMessage?: string;
  onStart: () => void;
}) {
  const hasQr = Boolean(login?.qr_image);
  return (
    <Centered>
      <Smartphone size={32} color={C.ok} />
      <span style={{ color: C.text, fontWeight: 650 }}>Подключите Telegram</span>
      <span style={{ maxWidth: 460, color: C.text2, fontSize: 13, lineHeight: 1.6 }}>
        В MVP v1 подключение будет через QR-код. Пользователь подключает свой Telegram сам; администратор только настраивает интеграцию.
      </span>
      {hasQr && (
        <div style={{ display: "grid", justifyItems: "center", gap: 10, padding: 14, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <img src={login?.qr_image} alt="QR-код для входа в Telegram" style={{ width: 220, height: 220, display: "block" }} />
          <span style={{ maxWidth: 320, color: C.text2, fontSize: 12, lineHeight: 1.5 }}>
            Откройте Telegram на телефоне: Настройки → Устройства → Подключить устройство.
          </span>
          {login?.status === "pending" && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.warnTx, fontSize: 12 }}><Loader2 size={13} style={{ animation: "lk-pulse 1s infinite" }} />Ждём подтверждения…</span>}
          {login?.status === "confirmed" && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.okTx, fontSize: 12 }}><Check size={14} />Telegram подключён</span>}
          {login?.status === "expired" && <span style={{ color: C.err, fontSize: 12 }}>QR-код истёк. Создайте новый.</span>}
          {login?.status === "password_required" && <span style={{ color: C.err, fontSize: 12 }}>Для этого аккаунта требуется 2FA. Вход по 2FA будет в v1.1.</span>}
          {login?.status === "error" && <span style={{ color: C.err, fontSize: 12 }}>{login.error || "Ошибка подключения"}</span>}
        </div>
      )}
      <button
        disabled={pending}
        onClick={onStart}
        style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 8, background: pending ? C.bg3 : C.ok, color: "white", fontWeight: 700 }}
      >
        {pending ? <Loader2 size={15} style={{ animation: "lk-pulse 1s infinite" }} /> : <Smartphone size={15} />}
        {hasQr ? "Создать новый QR" : "Подключить через QR"}
      </button>
      {errorCode === "telegram_worker_not_ready" && (
        <span style={{ maxWidth: 480, color: C.warnTx, background: C.warnBg, border: `1px solid ${C.warnBrd}`, borderRadius: 8, padding: "9px 11px", fontSize: 12, lineHeight: 1.5 }}>
          Backend-контракты готовы. Для выдачи QR нужно подключить следующий компонент: MTProto worker на GramJS.
        </span>
      )}
      {errorCode && errorCode !== "telegram_worker_not_ready" && (
        <span style={{ maxWidth: 480, color: C.err, background: C.errBg, border: `1px solid ${C.errBrd}`, borderRadius: 8, padding: "9px 11px", fontSize: 12, lineHeight: 1.5 }}>
          {errorMessage || errorCode}
        </span>
      )}
    </Centered>
  );
}

function Centered({ children, tone }: { children: ReactNode; tone?: "err" }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 12, textAlign: "center", color: tone === "err" ? C.err : C.text2 }}>
        {children}
      </div>
    </div>
  );
}
