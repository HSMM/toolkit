// Главная оболочка приложения для аутентифицированного пользователя.
// Перенос из apps/web/prototype.jsx (1783 LOC) на TypeScript с интеграцией
// нашего AuthContext и API-клиента. Внутренняя навигация — на state, без
// React Router (соответствует исходному дизайну прототипа).
//
// Что заменено относительно прототипа:
//   - USERS_INIT[0] (текущий пользователь) → useMe() из /api/v1/me
//   - LOGO_URL → импорт из styles/tokens (плейсхолдер для open source)
//   - кнопка «Выйти» в ProfileModal → useAuth().logout()
//
// Большая часть данных приходит из API; локальные state'ы — для UX-моментов
// (открытые модалки, выбранные элементы, фильтры) и тех модулей, под
// которые ещё нет endpoint'ов.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useState, useEffect, useRef, createContext, useContext,
  type ReactNode, type CSSProperties,
} from "react";
import {
  Phone, Video, MessageSquare, Users, FileText, HelpCircle,
  Settings, Mic, MicOff, PhoneOff, Monitor, Search,
  Download, Edit2, X, Check,
  RefreshCw, User, PhoneMissed,
  Save, Wifi, Hash, Shield, Clock, Mail, Key, LogOut,
  Copy, Upload, FileAudio, Trash2, Send, ChevronRight, Inbox,
  Bell, Activity, BarChart3, Headphones, ArrowRightLeft, Minus,
  Sparkles, MessageCircle, Smile, Frown, Meh, AlertTriangle, AlertCircle,
  type LucideIcon,
} from "lucide-react";

import { C, LOGO_URL } from "@/styles/tokens";
import { useAuth } from "@/auth/AuthContext";
import { type Me } from "@/api/me";
import {
  useMeetings, useCreateMeeting, useEndMeeting, useShareMeeting,
  useMeetingRecordings, downloadMeetingRecording,
  type Meeting as ApiMeeting, type RecordingFile,
} from "@/api/meetings";
import { MeetingRoom } from "@/MeetingRoom";
import { useAdminUsers } from "@/api/admin";
import {
  useModuleAccess, useUpdateModuleAccess,
  useSmtpConfig, useUpdateSmtpConfig,
} from "@/api/system-settings";
import {
  useTranscripts, useTranscript, useUploadTranscript,
  useDeleteTranscript, useRetryTranscript,
  useTranscriptAnalytics, useAudioBlob, downloadTxt, fetchTxt,
  type Transcript, type TranscriptStatus, type TranscriptSegment,
} from "@/api/transcripts";

// ──────────────────────────────────────────────────────────────────────────
// MockUser — view-model для ProfileModal и сайдбара (адаптер над Me и
// /admin/users). Назван «Mock» исторически — сейчас все поля заполняются
// из реального API; тип сохраняем чтобы не править весь UI разом.
// ──────────────────────────────────────────────────────────────────────────

type MockUser = {
  id: number; name: string; email: string; dept: string;
  ext: number | null; role: "admin" | "user"; st: "active" | "blocked";
  login: string; av: string; col: string;
  // Дополнительные поля профиля (заполняются для текущего пользователя из Me).
  avatarUrl?: string;
  position?: string;
  phone?: string;
  bitrixId?: string;
  uid?: string; // user_id (UUID) — для отображения в профиле
};

const STATUSES = {
  available: { label: "Доступен",       col: "#10b981" },
  busy:      { label: "Занят",          col: "#f59e0b" },
  dnd:       { label: "Не беспокоить",  col: "#ef4444" },
  lunch:     { label: "На обеде",       col: "#fb923c" },
  away:      { label: "Отошёл",         col: "#a1a1aa" },
} as const;
const STATUS_ORDER = ["available", "busy", "dnd", "lunch", "away"] as const;
type StatusKey = typeof STATUS_ORDER[number];

// Превращает email/имя в "ФИ" + цвет аватара
function avatarFromUser(u: { full_name?: string; name?: string; email: string }): { av: string; col: string } {
  const name = u.full_name || u.name || u.email;
  const parts = name.split(/\s+/).filter(Boolean);
  const av = (parts[0]?.[0] || name[0] || "?").toUpperCase()
    + (parts[1]?.[0] || "").toUpperCase();
  // Стабильный цвет по email-хешу
  const palette = ["#6366f1", "#10b981", "#f59e0b", "#8b5cf6", "#0ea5e9", "#14b8a6", "#f43f5e", "#a855f7"];
  let h = 0;
  for (let i = 0; i < u.email.length; i++) h = (h * 31 + u.email.charCodeAt(i)) | 0;
  const col = palette[Math.abs(h) % palette.length] ?? palette[0];
  return { av, col: col! };
}

function meAsMockUser(me: Me): MockUser {
  const display = me.full_name || me.email;
  const a = avatarFromUser({ full_name: me.full_name, email: me.email, name: display });
  const extNum = me.extension && /^\d+$/.test(me.extension) ? Number(me.extension) : null;
  return {
    id: 0,
    name: display,
    email: me.email,
    dept: me.department || "—",
    ext: extNum,
    role: me.role,
    st: "active",
    login: "Сейчас",
    av: a.av,
    col: a.col,
    avatarUrl: me.avatar_url,
    position: me.position,
    phone: me.phone,
    bitrixId: me.bitrix_id,
    uid: me.user_id,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Application notifications context
// ──────────────────────────────────────────────────────────────────────────

type Notif = {
  id: number; ts: number; read: boolean;
  type: "meeting" | "call" | "miss" | "transcription" | "request" | "system";
  title: string; desc?: string;
};

type AppCtxValue = {
  status: StatusKey;
  setStatus: (s: StatusKey) => void;
  notifs: Notif[];
  push: (n: Omit<Notif, "id" | "ts" | "read">) => void;
  markAllRead: () => void;
  remove: (id: number) => void;
  clear: () => void;
  unread: number;
  phoneOpen: boolean;
  setPhoneOpen: (v: boolean | ((b: boolean) => boolean)) => void;
  // OS-уведомления (Web Notifications API)
  osPerm: NotificationPermission | "unsupported";
  requestOSPerm: () => Promise<NotificationPermission | "unsupported">;
};

const AppCtx = createContext<AppCtxValue | null>(null);
function useApp(): AppCtxValue {
  const v = useContext(AppCtx);
  if (!v) throw new Error("useApp: AppProvider missing");
  return v;
}

// notifSupported — браузер поддерживает Web Notifications API (нет в Safari iOS).
const notifSupported = typeof window !== "undefined" && "Notification" in window;

// fireOSNotification — посылает уведомление в notification-center ОС.
// Требует granted permission (см. requestOSPerm). Безопасна к вызову даже
// если permission != granted: тихо ничего не делает.
function fireOSNotification(n: { title: string; body?: string; tag?: string }) {
  if (!notifSupported) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(n.title, {
      body: n.body,
      tag: n.tag,         // тот же tag → ОС склеит дубли
      icon: "/logo-toolkit.png",
    });
  } catch {
    // Brave shields / private mode могут блокировать — игнорируем.
  }
}

function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusKey>("available");
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [osPerm, setOsPerm] = useState<NotificationPermission | "unsupported">(
    notifSupported ? Notification.permission : "unsupported",
  );
  const requestOSPerm = async (): Promise<NotificationPermission | "unsupported"> => {
    if (!notifSupported) return "unsupported";
    try {
      const p = await Notification.requestPermission();
      setOsPerm(p);
      return p;
    } catch {
      return Notification.permission;
    }
  };
  const push: AppCtxValue["push"] = (n) => {
    const item = { id: Date.now() + Math.random(), ts: Date.now(), read: false, ...n };
    setNotifs((l) => [item, ...l]);
    // Дублируем в OS notification center когда страница не в фокусе и
    // у нас есть permission. На активной вкладке OS-popup только мешает.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      fireOSNotification({ title: item.title, body: item.desc, tag: String(item.id) });
    }
  };
  const markAllRead = () => setNotifs((l) => l.map((n) => ({ ...n, read: true })));
  const remove = (id: number) => setNotifs((l) => l.filter((n) => n.id !== id));
  const clear = () => setNotifs([]);
  const unread = notifs.filter((n) => !n.read).length;
  return (
    <AppCtx.Provider value={{ status, setStatus, notifs, push, markAllRead, remove, clear, unread, phoneOpen, setPhoneOpen, osPerm, requestOSPerm }}>
      {children}
    </AppCtx.Provider>
  );
}

function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000)    return "только что";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин. назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч. назад`;
  return new Date(ts).toLocaleDateString("ru-RU");
}

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

function Av({ i, c, sz = 32, src }: { i: string; c?: string; sz?: number; src?: string }) {
  const [err, setErr] = useState(false);
  const showImg = !!src && !err;
  return (
    <div style={{
      width: sz, height: sz, borderRadius: "50%", background: c || "#6366f1",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: sz > 40 ? 15 : sz > 30 ? 12 : 10, fontWeight: 600, color: "white", flexShrink: 0,
      overflow: "hidden",
    }}>
      {showImg
        ? <img src={src} alt="" onError={() => setErr(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        : i}
    </div>
  );
}

type BdgVariant = "def" | "adm" | "ok" | "err" | "warn" | "proc" | "blue";
function Bdg({ children, v = "def" }: { children: ReactNode; v?: BdgVariant }) {
  const S: Record<BdgVariant, { bg: string; tx: string; brd: string }> = {
    def:  { bg: C.bg3,    tx: C.text2,  brd: C.border },
    adm:  { bg: C.purpBg, tx: C.purpTx, brd: C.purpBrd },
    ok:   { bg: C.accBg,  tx: C.accTx,  brd: C.accBrd },
    err:  { bg: C.errBg,  tx: C.errTx,  brd: C.errBrd },
    warn: { bg: C.warnBg, tx: C.warnTx, brd: C.warnBrd },
    proc: { bg: C.warnBg, tx: C.warnTx, brd: C.warnBrd },
    blue: { bg: C.accBg,  tx: C.accTx,  brd: C.accBrd },
  };
  const s = S[v];
  return (
    <span style={{
      background: s.bg, color: s.tx, border: `1px solid ${s.brd}`,
      fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 999,
      whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4,
    }}>{children}</span>
  );
}

function Empty({ Icon = Inbox, title, sub, action }: {
  Icon?: LucideIcon; title: string; sub?: string; action?: ReactNode;
}) {
  return (
    <div style={{ padding: "60px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: 56, height: 56, borderRadius: 14, background: C.bg3, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
        <Icon size={24} color={C.text3} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.55, maxWidth: 340 }}>{sub}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

const inp = (): CSSProperties => ({
  width: "100%", padding: "9px 12px", border: `1px solid ${C.border}`,
  borderRadius: 8, fontSize: 14, color: C.text, outline: "none",
  boxSizing: "border-box", fontFamily: "inherit", background: C.card,
  transition: "border-color .12s",
});

function Lbl({ children }: { children: ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
      {children}
    </label>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ marginBottom: 14 }}><Lbl>{label}</Lbl>{children}</div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Notification bell
// ──────────────────────────────────────────────────────────────────────────

const NOTIF_META: Record<Notif["type"], { Icon: LucideIcon; col: string; bg: string }> = {
  meeting:       { Icon: Video,        col: C.acc,   bg: C.accBg },
  call:          { Icon: Phone,        col: C.acc,   bg: C.accBg },
  miss:          { Icon: PhoneMissed,  col: C.err,   bg: C.errBg },
  transcription: { Icon: FileText,     col: C.purp,  bg: C.purpBg },
  request:       { Icon: Hash,         col: C.warn,  bg: C.warnBg },
  system:        { Icon: Bell,         col: C.text2, bg: C.bg3 },
};

function NotificationBell() {
  const { notifs, markAllRead, remove, clear, unread, osPerm, requestOSPerm } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} title="Уведомления"
        style={{ position: "relative", width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: open ? C.bg3 : "transparent", color: open ? C.text : C.text2, cursor: "pointer", border: `1px solid ${open ? C.border : "transparent"}`, transition: "all .12s" }}
        onMouseEnter={(e) => { if (!open) { e.currentTarget.style.background = C.bg3; e.currentTarget.style.color = C.text; } }}
        onMouseLeave={(e) => { if (!open) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.text2; } }}>
        <Bell size={17} />
        {unread > 0 && (
          <span style={{ position: "absolute", top: 3, right: 3, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: C.err, color: "white", fontSize: 9.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${C.card}`, lineHeight: 1 }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 360, maxHeight: 480, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, boxShadow: "0 14px 40px rgba(0,0,0,0.14)", zIndex: 100, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Уведомления</div>
              <div style={{ fontSize: 11.5, color: C.text3, marginTop: 1 }}>
                {notifs.length === 0 ? "Нет новых" : unread > 0 ? `${unread} непрочитанных · ${notifs.length} всего` : `${notifs.length} прочитано`}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {unread > 0 && (
                <button onClick={markAllRead} style={{ fontSize: 11.5, color: C.accTx, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "4px 7px", borderRadius: 5, fontWeight: 500 }}>Прочитать всё</button>
              )}
              {notifs.length > 0 && (
                <button onClick={clear} style={{ fontSize: 11.5, color: C.text2, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "4px 7px", borderRadius: 5 }}>Очистить</button>
              )}
            </div>
          </div>

          {/* Запрос разрешения на OS-уведомления — показывается если default,
              чтобы не мешать тем у кого уже granted/denied. */}
          {osPerm === "default" && (
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.accBg, display: "flex", alignItems: "center", gap: 10 }}>
              <Bell size={16} color={C.acc} />
              <div style={{ flex: 1, fontSize: 12, color: C.text, lineHeight: 1.4 }}>
                Получать уведомления в центре уведомлений ОС, когда Toolkit не в фокусе?
              </div>
              <button onClick={() => void requestOSPerm()}
                style={{ background: C.acc, color: "white", border: "none", padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                Включить
              </button>
            </div>
          )}
          {osPerm === "denied" && (
            <div style={{ padding: "8px 14px", borderBottom: `1px solid ${C.border}`, background: C.warnBg, fontSize: 11.5, color: C.warnTx, lineHeight: 1.45 }}>
              OS-уведомления заблокированы в браузере. Включите их в настройках сайта (значок 🔒 рядом с адресом).
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto" }}>
            {notifs.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center" }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: C.bg3, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                  <Bell size={20} color={C.text3} />
                </div>
                <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>Новых уведомлений нет</div>
                <div style={{ fontSize: 11.5, color: C.text3, marginTop: 4, lineHeight: 1.5 }}>Здесь появятся пропущенные звонки,<br />приглашения и готовые транскрибации</div>
              </div>
            ) : notifs.map((n) => {
              const meta = NOTIF_META[n.type] ?? NOTIF_META.system;
              const M = meta.Icon;
              return (
                <div key={n.id} style={{ padding: "11px 14px", display: "flex", gap: 10, background: n.read ? "transparent" : C.accBg, borderLeft: n.read ? "3px solid transparent" : `3px solid ${C.acc}`, borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: meta.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                    <M size={15} color={meta.col} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{n.title}</div>
                    {n.desc && <div style={{ fontSize: 11.5, color: C.text2, marginTop: 2, lineHeight: 1.45 }}>{n.desc}</div>}
                    <div style={{ fontSize: 10.5, color: C.text3, marginTop: 4 }}>{fmtRelTime(n.ts)}</div>
                  </div>
                  <button onClick={() => remove(n.id)} title="Удалить"
                    style={{ width: 22, height: 22, borderRadius: 5, background: "transparent", color: C.text3, cursor: "pointer", border: "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, alignSelf: "flex-start", opacity: 0.6, padding: 0 }}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Status selector + Phone toggle (bottom of sidebar)
// ──────────────────────────────────────────────────────────────────────────

function StatusSelector({ expanded }: { expanded: boolean }) {
  const { status, setStatus } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const cur = STATUSES[status];

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button onClick={() => setOpen((o) => !o)} title={!expanded ? `Статус: ${cur.label} · изменить` : undefined}
        style={{ width: "100%", padding: "7px 10px", borderRadius: 8, background: open ? C.bg3 : "transparent", display: "flex", alignItems: "center", gap: 10, border: "none", cursor: "pointer", fontFamily: "inherit", transition: "background .12s", whiteSpace: "nowrap", overflow: "hidden" }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = C.bg3; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}>
        <div style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: cur.col, boxShadow: status === "available" ? `0 0 0 2px ${cur.col}33` : "none" }} />
        </div>
        <span style={{ flex: 1, textAlign: "left", fontSize: 12.5, fontWeight: 500, color: C.text2, opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms" }}>{cur.label}</span>
        {expanded && <ChevronRight size={12} color={C.text3} style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform .15s" }} />}
      </button>
      {open && (
        <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, right: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 14px 32px rgba(0,0,0,0.12)", padding: 4, zIndex: 30, minWidth: expanded ? 0 : 190 }}>
          {STATUS_ORDER.map((id) => {
            const s = STATUSES[id];
            const active = id === status;
            return (
              <button key={id} onClick={() => { setStatus(id); setOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", borderRadius: 6, background: active ? C.accBg : "transparent", color: active ? C.accTx : C.text, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: active ? 600 : 500, textAlign: "left", whiteSpace: "nowrap" }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.bg3; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: s.col, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{s.label}</span>
                {active && <Check size={13} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PhoneToggle({ expanded }: { expanded: boolean }) {
  const { phoneOpen, setPhoneOpen } = useApp();
  return (
    <button onClick={() => setPhoneOpen((o) => !o)} title={phoneOpen ? "Скрыть софтфон" : "Открыть софтфон"}
      style={{
        width: expanded ? 34 : "100%", height: 34, borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: phoneOpen ? C.acc : "transparent",
        color: phoneOpen ? "white" : C.text2,
        cursor: "pointer", border: phoneOpen ? "none" : `1px solid ${C.border}`,
        flexShrink: 0, transition: "all .12s", fontFamily: "inherit",
      }}
      onMouseEnter={(e) => { if (!phoneOpen) { e.currentTarget.style.background = C.bg3; e.currentTarget.style.color = C.text; } }}
      onMouseLeave={(e) => { if (!phoneOpen) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.text2; } }}>
      <Phone size={15} strokeWidth={2} />
    </button>
  );
}

function BottomActions({ expanded }: { expanded: boolean }) {
  return (
    <div style={{ padding: "0 4px 4px", display: "flex", flexDirection: expanded ? "row" : "column", alignItems: "stretch", gap: 4 }}>
      <StatusSelector expanded={expanded} />
      <PhoneToggle expanded={expanded} />
    </div>
  );
}

function PgHdr({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div style={{ padding: "22px 28px 18px", borderBottom: `1px solid ${C.border}`, background: C.card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text, letterSpacing: "-0.02em", fontFamily: "inherit" }}>{title}</h1>
        {sub && <p style={{ margin: "3px 0 0", fontSize: 13.5, color: C.text2 }}>{sub}</p>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {action}
        <NotificationBell />
      </div>
    </div>
  );
}

type NavItemDef = { id: string; label: string; Icon: LucideIcon; stub?: boolean };

function NavItem({ item, active, expanded, onClick }: {
  item: NavItemDef; active: boolean; expanded: boolean; onClick: () => void;
}) {
  const [hov, setHov] = useState(false);
  const bg = active ? C.bg3 : hov ? C.bg3 : "transparent";
  const col = active ? C.text : C.text2;
  return (
    <button onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      title={!expanded ? item.label : undefined}
      style={{ display: "flex", alignItems: "center", gap: 11, width: "calc(100% - 8px)", margin: "1px 4px", padding: "9px 12px", borderRadius: 8, background: bg, color: col, transition: "background 120ms, color 120ms", position: "relative", cursor: "pointer", border: "none", fontFamily: "inherit", overflow: "hidden", whiteSpace: "nowrap" }}>
      <item.Icon size={18} style={{ flexShrink: 0 }} strokeWidth={active ? 2.1 : 1.75} />
      <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 500, flex: 1, textAlign: "left", opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms" }}>{item.label}</span>
      {item.stub && <span style={{ fontSize: 10, fontWeight: 600, background: C.bg, border: `1px solid ${C.border}`, color: C.text3, padding: "1px 6px", borderRadius: 4, opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms" }}>скоро</span>}
      {active && <div style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", width: 3, height: 18, background: C.acc, borderRadius: "0 2px 2px 0" }} />}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SOFTPHONE WIDGET (плавающий, в правом нижнем углу)
// ──────────────────────────────────────────────────────────────────────────

type CallState = "idle" | "calling" | "active";

function SoftphoneWidget() {
  const { phoneOpen, setPhoneOpen } = useApp();
  const [val, setVal] = useState("");
  const [cs, setCs] = useState<CallState>("idle");
  const [sec, setSec] = useState(0);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const tmr = useRef<ReturnType<typeof setInterval> | null>(null);
  const call = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const startCall = () => {
    if (!val) return;
    setCs("calling");
    call.current = setTimeout(() => {
      setCs("active"); setSec(0);
      tmr.current = setInterval(() => setSec((s) => s + 1), 1000);
    }, 1600);
  };

  const hangUp = () => {
    if (call.current) clearTimeout(call.current);
    if (tmr.current) clearInterval(tmr.current);
    setCs("idle"); setSec(0); setMuted(false); setHeld(false); setVal("");
  };

  useEffect(() => () => {
    if (call.current) clearTimeout(call.current);
    if (tmr.current) clearInterval(tmr.current);
  }, []);

  const pad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  const inCall = cs !== "idle";

  return (
    <div style={{
      position: "fixed", right: 24, bottom: 24, zIndex: 150, width: 320,
      background: C.card, borderRadius: 16,
      boxShadow: "0 18px 50px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.05)",
      border: `1px solid ${C.border}`, overflow: "hidden",
      display: phoneOpen ? "block" : "none",
    }}>
      <style>{`@keyframes blink{0%,100%{opacity:.25;transform:scale(.75)}50%{opacity:1;transform:scale(1)}}`}</style>

      <div style={{ padding: "10px 8px 10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: inCall ? C.accBg : C.bg3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Phone size={12} color={inCall ? C.acc : C.text2} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Софтфон</span>
          {inCall && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.acc, fontWeight: 600, marginLeft: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.acc }} />
              {cs === "active" ? fmt(sec) : "вызов…"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button onClick={() => setMinimized((m) => !m)} title={minimized ? "Развернуть" : "Свернуть"}
            style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", color: C.text2, cursor: "pointer", border: "none" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.bg3; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            <Minus size={14} />
          </button>
          <button onClick={() => setPhoneOpen(false)} title="Закрыть"
            style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", color: C.text2, cursor: "pointer", border: "none" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.bg3; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {!minimized && <>
        <div style={{ padding: "10px 14px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.text3 }} />
            <span style={{ color: C.text2, fontSize: 11.5, fontWeight: 500 }}>Номер не назначен</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, color: C.text3, fontSize: 11 }}>
            <Wifi size={11} /><span>FreePBX</span>
          </div>
        </div>

        <div style={{ padding: "22px 18px 12px", textAlign: "center", minHeight: 108 }}>
          {cs === "idle" && (
            <div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: val ? 28 : 14, fontWeight: 500, color: val ? C.text : C.text3, letterSpacing: "0.02em", minHeight: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {val || "Введите номер"}
              </div>
              {val && <button onClick={() => setVal((v) => v.slice(0, -1))} style={{ marginTop: 4, color: C.text2, fontSize: 12, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>← удалить</button>}
            </div>
          )}
          {cs === "calling" && (
            <div>
              <div style={{ fontSize: 13, color: C.text2, marginBottom: 6 }}>Вызов…</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 500, color: C.text }}>{val}</div>
              <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 5 }}>
                {[0, 1, 2].map((i) => <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: C.acc, animation: `blink 1.2s ease-in-out ${i * 0.22}s infinite` }} />)}
              </div>
            </div>
          )}
          {cs === "active" && (
            <div>
              <div style={{ fontSize: 11.5, color: C.acc, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.acc }} />В разговоре
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 500, color: C.text }}>{val}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, color: C.text2, fontWeight: 500, marginTop: 4 }}>{fmt(sec)}</div>
            </div>
          )}
        </div>

        {cs === "idle" && (
          <div style={{ padding: "0 18px 14px", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            {pad.map((k) => (
              <button key={k} onClick={() => setVal((v) => v + k)}
                style={{ padding: "12px 0", borderRadius: 10, background: C.bg3, color: C.text, fontSize: 17, fontWeight: 500, border: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "'DM Mono', monospace" }}>
                {k}
              </button>
            ))}
          </div>
        )}
        {cs === "active" && (
          <div style={{ padding: "0 18px 14px", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            {[
              { icon: muted ? MicOff : Mic, lbl: muted ? "Вкл." : "Без звука", on: muted, fn: () => setMuted((m) => !m) },
              { icon: Monitor, lbl: "Запись", on: false, fn: () => { } },
              { icon: Phone, lbl: held ? "Снять" : "Удерж.", on: held, fn: () => setHeld((h) => !h) },
            ].map((b, i) => (
              <button key={i} onClick={b.fn}
                style={{ padding: "10px 0", borderRadius: 10, background: b.on ? C.text : C.bg3, color: b.on ? "white" : C.text2, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `1px solid ${b.on ? C.text : C.border}`, cursor: "pointer", fontFamily: "inherit", fontSize: 10.5, fontWeight: 500 }}>
                <b.icon size={16} /><span>{b.lbl}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{ padding: "0 18px 18px", display: "flex", justifyContent: "center" }}>
          {cs === "idle"
            ? <button onClick={startCall} disabled={!val} style={{ width: 56, height: 56, borderRadius: "50%", background: val ? C.acc : C.bg3, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: val ? "pointer" : "default", boxShadow: val ? `0 4px 16px ${C.acc}40` : "none" }}>
              <Phone size={22} color={val ? "white" : C.text3} />
            </button>
            : <button onClick={hangUp} style={{ width: 56, height: 56, borderRadius: "50%", background: C.err, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: `0 4px 16px ${C.err}40` }}>
              <PhoneOff size={22} color="white" />
            </button>}
        </div>
      </>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// VCS (Видеоконференции) — реальная интеграция с LiveKit через /api/v1/meetings
// ──────────────────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// MeetingDuration — таймер с тиком в 1с пока встреча идёт; для завершённой
// показывает общую длительность статично.
function MeetingDuration({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endedAt]);
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return <>{fmtDuration(end - start)}</>;
}

function RecordingsMenu({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useMeetingRecordings(open ? meetingId : null);

  const labelFor = (r: RecordingFile): { icon: typeof Video; text: string; sub: string } => {
    if (r.kind === "meeting_composite") return { icon: Video, text: "Видео встречи", sub: "MP4 · видео + аудио" };
    if (r.kind === "meeting_audio")     return { icon: Mic,   text: "Аудио встречи", sub: "OGG · только звук" };
    return { icon: FileAudio, text: "Дорожка участника", sub: r.mime_type };
  };

  const dl = async (r: RecordingFile) => {
    setBusy(r.id);
    try { await downloadMeetingRecording(meetingId, r.id, r.filename); }
    catch (e) { alert("Не удалось скачать: " + (e instanceof Error ? e.message : String(e))); }
    finally { setBusy(null); }
  };

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} title="Скачать запись"
        style={{ background: C.card, color: C.text2, padding: "8px 12px", borderRadius: 8, fontWeight: 500, fontSize: 13, border: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
        <Download size={13} />Записи
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 280, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 40, padding: 6 }}>
            {q.isLoading ? (
              <div style={{ padding: "12px 14px", color: C.text3, fontSize: 12.5 }}>Загрузка…</div>
            ) : (q.data ?? []).length === 0 ? (
              <div style={{ padding: "12px 14px", color: C.text3, fontSize: 12.5 }}>
                Записи ещё не появились. Это может занять минуту после остановки записи.
              </div>
            ) : (q.data ?? []).map((r) => {
              const L = labelFor(r);
              const sizeMb = (r.size_bytes / 1_048_576).toFixed(1);
              return (
                <button key={r.id} onClick={() => void dl(r)} disabled={busy === r.id}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", border: "none", borderRadius: 7, background: "transparent", cursor: busy === r.id ? "default" : "pointer", textAlign: "left", fontFamily: "inherit", opacity: busy === r.id ? 0.6 : 1 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: C.accBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <L.icon size={15} color={C.acc} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{L.text}</div>
                    <div style={{ fontSize: 11, color: C.text3 }}>{L.sub} · {sizeMb} МБ</div>
                  </div>
                  {busy === r.id ? <RefreshCw size={14} color={C.text3} className="lk-spin" /> : <Download size={14} color={C.text2} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function VcsPage({ me, onOpenTranscriptions }: { me: Me; onOpenTranscriptions?: (meetingId: string) => void }) {
  const { push } = useApp();
  const meetingsQ = useMeetings();
  const create = useCreateMeeting();
  const end = useEndMeeting();
  const share = useShareMeeting();

  const [modal, setModal] = useState(false);
  const [active, setActive] = useState<ApiMeeting | null>(null); // открытая комната
  const [copiedFor, setCopiedFor] = useState<string | null>(null); // meetingId для checkmark
  const shareLink = async (m: ApiMeeting) => {
    try {
      const { token } = await share.mutateAsync(m.id);
      const url = `${window.location.origin}/g/${token}`;
      await navigator.clipboard.writeText(url);
      setCopiedFor(m.id);
      setTimeout(() => setCopiedFor((cur) => (cur === m.id ? null : cur)), 2200);
      push({ type: "meeting", title: "Гостевая ссылка скопирована", desc: url });
    } catch (e) {
      push({ type: "system", title: "Не удалось получить ссылку", desc: e instanceof Error ? e.message : String(e) });
    }
  };

  const [mode, setMode] = useState<"schedule" | "instant">("instant");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00");
  // Транскрибация триггерится вручную из истории встреч (см. модуль
  // «Транскрибация»). На форме создания не показываем.
  const [record, setRecord] = useState(true);

  const resetForm = () => { setTitle(""); setRecord(true); };
  const openModal = (m: "schedule" | "instant") => { resetForm(); setMode(m); setModal(true); };
  const closeModal = () => setModal(false);

  const submit = async () => {
    if (!title.trim()) return;
    let scheduledISO: string | undefined;
    if (mode === "schedule" && date && time) {
      scheduledISO = new Date(`${date}T${time}:00`).toISOString();
    }
    try {
      const m = await create.mutateAsync({
        title: title.trim(),
        scheduled_at: scheduledISO,
        record_enabled: record,
        auto_transcribe: false,
      });
      closeModal();
      push({
        type: "meeting",
        title: mode === "schedule" ? "Встреча запланирована" : "Встреча запущена",
        desc: `«${m.title}» · ${m.livekit_room_id}`,
      });
      if (mode === "instant") setActive(m);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push({ type: "system", title: "Не удалось создать встречу", desc: msg });
    }
  };

  const meetings = meetingsQ.data ?? [];
  const fmtMeetingTime = (m: ApiMeeting): string => {
    const ref = m.started_at || m.scheduled_at || m.created_at;
    const d = new Date(ref);
    const now = Date.now();
    if (Math.abs(now - d.getTime()) < 86_400_000 / 2 && m.started_at) return "Сейчас · " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("ru-RU") + " · " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };
  const isHost = (m: ApiMeeting) => m.created_by === me.user_id || me.role === "admin";
  const canCreate = title.trim().length > 0;

  return (
    <div style={{ minHeight: "100%", background: C.bg2 }}>
      <PgHdr title="Видеоконференции" sub="LiveKit SFU · собственный контур"
        action={
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => openModal("schedule")} style={{ display: "flex", alignItems: "center", gap: 7, background: C.card, color: C.text, padding: "9px 16px", borderRadius: 8, fontWeight: 500, fontSize: 14, border: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit" }}>
              <Clock size={15} />Запланировать
            </button>
            <button onClick={() => openModal("instant")} style={{ display: "flex", alignItems: "center", gap: 7, background: C.acc, color: "white", padding: "9px 18px", borderRadius: 8, fontWeight: 500, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              <Video size={15} />Создать сейчас
            </button>
          </div>
        }
      />
      <div style={{ padding: 24 }}>
        {meetingsQ.isLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: C.text3, fontSize: 13 }}>Загрузка…</div>
        ) : meetings.length === 0 ? (
          <Empty Icon={Video}
            title="Нет встреч"
            sub="Создайте встречу сейчас или запланируйте на будущее. Приглашение коллег появится после синхронизации пользователей с Bitrix24."
            action={<button onClick={() => openModal("instant")} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: C.acc, color: "white", padding: "9px 18px", borderRadius: 8, fontWeight: 500, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit" }}><Video size={15} />Создать встречу</button>}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {meetings.map((m) => {
              const ended = !!m.ended_at;
              const live = !!m.started_at && !ended;
              return (
                <div key={m.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "15px 18px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: ended ? C.bg3 : C.accBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Video size={18} color={ended ? C.text3 : C.acc} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{m.title}</div>
                        {live && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 999, background: C.accBg, color: C.accTx, fontSize: 11, fontWeight: 600, border: `1px solid ${C.accBrd}` }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.acc, boxShadow: `0 0 0 2px ${C.acc}33` }} />
                            В эфире · <span style={{ fontFamily: "'DM Mono', monospace" }}><MeetingDuration startedAt={m.started_at!} /></span>
                          </span>
                        )}
                        {m.auto_transcribe && <Bdg v="blue">С транскрибацией</Bdg>}
                        {m.recording_active
                          ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 999, background: C.errBg, color: C.err, fontSize: 11, fontWeight: 600, border: `1px solid ${C.errBrd}` }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.err, animation: "lk-pulse 1.2s ease-in-out infinite" }} />
                              Идёт запись
                            </span>
                          : (m.record_enabled && <Bdg v="proc">Запись</Bdg>)}
                      </div>
                      <div style={{ fontSize: 12.5, color: C.text2, marginTop: 3 }}>
                        {fmtMeetingTime(m)}
                        {ended && m.started_at && (
                          <> · длилась <span style={{ fontFamily: "'DM Mono', monospace" }}><MeetingDuration startedAt={m.started_at} endedAt={m.ended_at} /></span></>
                        )}
                        {" · room "}<span style={{ fontFamily: "'DM Mono', monospace" }}>{m.livekit_room_id}</span>
                      </div>
                    </div>
                    <div style={{ flexShrink: 0, display: "flex", gap: 6, alignItems: "center" }}>
                      {ended ? (
                        <>
                          <Bdg v="def">Завершена</Bdg>
                          {m.recording_started_at && (
                            <RecordingsMenu meetingId={m.id} />
                          )}
                          {m.recording_started_at && onOpenTranscriptions && (
                            <button onClick={() => onOpenTranscriptions(m.id)} title="Открыть расшифровки этой встречи"
                              style={{ background: C.accBg, color: C.accTx, padding: "8px 12px", borderRadius: 8, fontWeight: 500, fontSize: 13, border: `1px solid ${C.accBrd}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                              <FileText size={13} />Расшифровки
                            </button>
                          )}
                        </>
                      ) : <>
                          {isHost(m) && (
                            <button onClick={() => void shareLink(m)} title="Скопировать ссылку для гостя"
                              style={{ background: C.card, color: copiedFor === m.id ? C.acc : C.text2, padding: "8px 10px", borderRadius: 8, fontSize: 13, border: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                              {copiedFor === m.id ? <><Check size={14} />Скопировано</> : <><Copy size={14} />Гостевая ссылка</>}
                            </button>
                          )}
                          <button onClick={() => setActive(m)} style={{ background: C.acc, color: "white", padding: "8px 16px", borderRadius: 8, fontWeight: 500, fontSize: 13, border: "none", cursor: "pointer", fontFamily: "inherit" }}>Войти</button>
                          {isHost(m) && (
                            <button onClick={() => { if (confirm("Завершить встречу?")) end.mutate(m.id); }}
                              style={{ background: C.card, color: C.err, padding: "8px 12px", borderRadius: 8, fontWeight: 500, fontSize: 13, border: `1px solid ${C.errBrd}`, cursor: "pointer", fontFamily: "inherit" }}>
                              Завершить
                            </button>
                          )}
                        </>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modal && (
        <div onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", overflowY: "auto" }}>
          <div style={{ background: C.card, borderRadius: 12, width: "100%", maxWidth: 520, boxShadow: "0 20px 50px rgba(0,0,0,0.15)", maxHeight: "calc(100vh - 80px)", display: "flex", flexDirection: "column", overflow: "hidden", border: `1px solid ${C.border}` }}>
            <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.text }}>{mode === "schedule" ? "Запланировать встречу" : "Новая встреча"}</h3>
                <p style={{ margin: "3px 0 0", fontSize: 12.5, color: C.text2 }}>{mode === "schedule" ? "Запланируется на выбранное время" : "Начнётся сразу после создания"}</p>
              </div>
              <button onClick={closeModal} style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", color: C.text2, cursor: "pointer", border: "none" }}><X size={18} /></button>
            </div>
            <div style={{ padding: "14px 22px 0", display: "flex", gap: 6, flexShrink: 0 }}>
              {([{ v: "schedule" as const, l: "Запланировать", Icon: Clock }, { v: "instant" as const, l: "Начать сейчас", Icon: Video }]).map((t) => (
                <button key={t.v} onClick={() => setMode(t.v)}
                  style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: `1px solid ${mode === t.v ? C.acc : C.border}`, background: mode === t.v ? C.accBg : C.card, color: mode === t.v ? C.accTx : C.text2, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <t.Icon size={14} />{t.l}
                </button>
              ))}
            </div>
            <div style={{ overflowY: "auto", padding: "18px 22px" }}>
              <Field label="Название">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Обсуждение релиза" style={inp()} autoFocus />
              </Field>
              {mode === "schedule" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, marginBottom: 14 }}>
                  <Field label="Дата"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp()} /></Field>
                  <Field label="Время"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inp()} /></Field>
                </div>
              )}
              {[
                { v: record, set: setRecord, t: "Запись встречи", d: "Композитная запись (видео+аудио MP4 + отдельная аудио-дорожка для транскрибации) сохраняется в MinIO." },
              ].map((opt, i) => (
                <label key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${opt.v ? C.acc : C.border}`, borderRadius: 10, cursor: "pointer", background: opt.v ? C.accBg : C.card, marginBottom: 8 }}>
                  <div style={{ position: "relative", width: 36, height: 20, background: opt.v ? C.acc : C.border2, borderRadius: 10, flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 2, left: opt.v ? 18 : 2, width: 16, height: 16, background: "white", borderRadius: "50%", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
                  </div>
                  <input type="checkbox" checked={opt.v} onChange={(e) => opt.set(e.target.checked)} style={{ display: "none" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{opt.t}</div>
                    <div style={{ fontSize: 12, color: C.text2, marginTop: 2, lineHeight: 1.4 }}>{opt.d}</div>
                  </div>
                </label>
              ))}
              <div style={{ marginTop: 12, padding: "10px 12px", background: C.warnBg, border: `1px solid ${C.warnBrd}`, borderRadius: 8, fontSize: 12, color: C.warnTx, lineHeight: 1.4 }}>
                В этой версии ссылка на встречу — только у создателя. Приглашение коллег по email и поиск участников появятся после синхронизации пользователей с Bitrix24.
              </div>
            </div>
            <div style={{ padding: "14px 22px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 10, justifyContent: "flex-end", background: C.card, flexShrink: 0 }}>
              <button onClick={closeModal} style={{ padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontWeight: 500, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Отмена</button>
              <button onClick={() => void submit()} disabled={!canCreate || create.isPending}
                style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: canCreate && !create.isPending ? C.acc : C.bg3, color: canCreate && !create.isPending ? "white" : C.text3, fontWeight: 600, fontSize: 14, cursor: canCreate && !create.isPending ? "pointer" : "default", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7 }}>
                {mode === "schedule" ? <><Clock size={14} />Запланировать</> : <><Video size={14} />Начать встречу</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {active && <MeetingRoom meeting={active} isHost={isHost(active)} onClose={() => setActive(null)} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TRANSCRIPTION — viewer с плеером, диалог-бабблами, аналитикой и AI
// ──────────────────────────────────────────────────────────────────────────

const ALLOWED_AUDIO = [".wav", ".ogg", ".mp3", ".m4a", ".mp4", ".wma", ".flac", ".aac"];
const MAX_UPLOAD_MB = 500;

// Палитра для каналов / спикеров (8 цветов, повтор по hash).
const SPEAKER_PALETTE = ["#1E5AA8", "#10b981", "#f59e0b", "#a855f7", "#ef4444", "#0ea5e9", "#14b8a6", "#f43f5e"];

function speakerColor(ref: string): string {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % SPEAKER_PALETTE.length;
  return SPEAKER_PALETTE[idx]!;
}

function speakerLabel(ref: string): string {
  if (ref.startsWith("channel:")) return "Канал " + ref.slice(8);
  if (ref === "side:internal") return "Внутр.";
  if (ref === "side:external") return "Внешн.";
  if (ref.startsWith("external:")) return ref.slice(9);
  if (ref.startsWith("user:")) return "Сотрудник";
  return ref;
}

function fmtBytes(b: number): string {
  const mb = b / 1_048_576;
  if (mb < 1) return `${(b / 1024).toFixed(0)} КБ`;
  return `${mb.toFixed(1)} МБ`;
}

function fmtUploadedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function statusBadge(s: TranscriptStatus): React.ReactElement | null {
  switch (s) {
    case "queued":     return <Bdg v="proc">В очереди</Bdg>;
    case "processing": return <Bdg v="proc">Обработка…</Bdg>;
    case "completed":  return <Bdg v="ok">Готово</Bdg>;
    case "partial":    return <Bdg v="warn">Частично</Bdg>;
    case "failed":     return <Bdg v="err">Ошибка</Bdg>;
    case "pending":    return <Bdg v="def">Создан</Bdg>;
    default:           return null;
  }
}

function fmtSeg(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function TranscriptionPage({ meetingFilter }: { meetingFilter?: string } = {}) {
  const list = useTranscripts(meetingFilter ? { meetingId: meetingFilter } : undefined);
  const upload = useUploadTranscript();
  const del = useDeleteTranscript();
  const retry = useRetryTranscript();

  const [selId, setSelId] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const items: Transcript[] = list.data?.items ?? [];
  const showErr = (m: string) => { setErr(m); setTimeout(() => setErr(""), 5000); };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_AUDIO.includes(ext)) {
      showErr(`Формат «${ext || "без расширения"}» не поддерживается. Допустимо: ${ALLOWED_AUDIO.join(", ")}`);
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1_048_576) {
      showErr(`Файл ${fmtBytes(file.size)} превышает лимит ${MAX_UPLOAD_MB} МБ`);
      return;
    }
    upload.mutate(file, {
      onSuccess: (res) => { setSelId(res.transcript_id); },
      onError: (e) => { showErr(e instanceof Error ? e.message : "Ошибка загрузки"); },
    });
  };

  return (
    <div style={{ height: "100%", background: C.bg2, display: "flex", flexDirection: "column" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <PgHdr title="Транскрибация" sub="GigaAM ASR · диалог по каналам, аналитика, экспорт" />
      {err && (
        <div style={{ background: C.errBg, borderBottom: `1px solid ${C.errBrd}`, padding: "10px 22px", color: C.errTx, fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
          <X size={15} /><span style={{ flex: 1 }}>{err}</span>
          <button onClick={() => setErr("")} style={{ background: "none", border: "none", cursor: "pointer", color: C.errTx, padding: 4 }}><X size={14} /></button>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* LEFT: список */}
        <div style={{ width: 320, background: C.card, borderRight: `1px solid ${C.border}`, overflowY: "auto", flexShrink: 0 }}>
          <div style={{ padding: "14px 14px 12px", borderBottom: `1px solid ${C.border}` }}>
            <div onClick={() => { if (!upload.isPending) fileRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
              style={{ border: `2px dashed ${drag ? C.acc : C.border2}`, borderRadius: 10, padding: "15px 10px", textAlign: "center", cursor: upload.isPending ? "default" : "pointer", background: drag ? C.accBg : C.bg2, opacity: upload.isPending ? 0.6 : 1 }}>
              <Upload size={19} color={drag ? C.acc : C.text2} style={{ marginBottom: 7 }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 3 }}>
                {upload.isPending ? "Загружаем…" : drag ? "Отпустите файл" : "Загрузить аудио"}
              </div>
              <div style={{ fontSize: 10.5, color: C.text3, lineHeight: 1.55 }}>WAV, OGG, MP3, M4A, MP4, WMA, FLAC, AAC<br />до {MAX_UPLOAD_MB} МБ · моно / стерео</div>
            </div>
            <input ref={fileRef} type="file" accept={ALLOWED_AUDIO.join(",") + ",audio/*,video/mp4"} style={{ display: "none" }}
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          {list.isLoading ? (
            <div style={{ padding: "32px 20px", textAlign: "center", color: C.text3, fontSize: 13 }}>Загрузка списка…</div>
          ) : list.isError ? (
            <div style={{ padding: "20px", color: C.err, fontSize: 13 }}>Ошибка: {String(list.error)}</div>
          ) : items.length === 0 ? (
            <div style={{ padding: "32px 20px", textAlign: "center" }}>
              <FileAudio size={22} color={C.text3} style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 12.5, color: C.text2, fontWeight: 500 }}>Список пуст</div>
              <div style={{ fontSize: 11.5, color: C.text3, marginTop: 3, lineHeight: 1.5 }}>Загрузите аудио — оно отправится на расшифровку</div>
            </div>
          ) : items.map((t) => (
            <div key={t.id} onClick={() => setSelId(t.id)}
              style={{ padding: "13px 16px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: selId === t.id ? C.accBg : "transparent", borderLeft: selId === t.id ? `3px solid ${C.acc}` : "3px solid transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: C.warnBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                  <FileAudio size={14} color={C.warn} />
                </div>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.filename || "(без имени)"}</div>
                  <div style={{ fontSize: 11, color: C.text3, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {fmtUploadedAt(t.uploaded_at)} · {fmtBytes(t.size_bytes)}
                  </div>
                  <div style={{ marginTop: 5 }}>{statusBadge(t.status)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT: viewer */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selId ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Empty Icon={FileAudio} title="Выберите запись или загрузите файл" sub="Транскрибированные звонки и загруженные файлы появляются здесь." />
            </div>
          ) : (
            <TranscriptViewer
              key={selId}
              transcriptId={selId}
              onDeleteOk={() => {
                const idx = items.findIndex((t) => t.id === selId);
                const next = items.filter((t) => t.id !== selId);
                setSelId(next.length > 0 ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : null);
              }}
              onRetry={(id, cb) => retry.mutate(id, cb)}
              onDelete={(id, cb) => del.mutate(id, cb)}
              showErr={showErr}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TranscriptViewer — правая панель с плеером, табами, диалогом, аналитикой, AI
// ──────────────────────────────────────────────────────────────────────────

type ViewerTab = "dialog" | "analytics" | "ai";

function TranscriptViewer({
  transcriptId, onDeleteOk, onRetry, onDelete, showErr,
}: {
  transcriptId: string;
  onDeleteOk: () => void;
  onRetry: (id: string, cb: { onError?: (e: unknown) => void }) => void;
  onDelete: (id: string, cb: { onSuccess?: () => void; onError?: (e: unknown) => void }) => void;
  showErr: (m: string) => void;
}) {
  const tQ = useTranscript(transcriptId);
  const t = tQ.data ?? null;

  const [tab, setTab] = useState<ViewerTab>("dialog");
  const [currentSec, setCurrentSec] = useState(0);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const audio = useAudioBlob(t && (t.status === "completed" || t.status === "partial") ? transcriptId : null);

  const seekTo = (ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => {/* autoplay blocked */});
  };

  if (tQ.isLoading || !t) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.text3 }}>Загрузка…</div>;
  }

  const isBusy = t.status === "queued" || t.status === "processing" || t.status === "pending";

  const handleCopy = async () => {
    try {
      const txt = await fetchTxt(t.id);
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      showErr(e instanceof Error ? e.message : "Не удалось скопировать");
    }
  };

  const handleDownloadTxt = async () => {
    try {
      await downloadTxt(t.id, t.filename);
    } catch (e) {
      showErr(e instanceof Error ? e.message : "Не удалось скачать TXT");
    }
  };

  return (
    <>
      {/* Header */}
      <div style={{ padding: "14px 22px", background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexShrink: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.filename}</div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>
            {fmtUploadedAt(t.uploaded_at)} · {fmtBytes(t.size_bytes)} · {t.mime_type || "audio"}
            {t.execution_time_ms ? ` · обработка ${(t.execution_time_ms / 1000).toFixed(1)}с` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          {statusBadge(t.status)}
          {(t.status === "completed" || t.status === "partial") && (
            <>
              <button onClick={handleCopy} title="Скопировать текст"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: copied ? C.acc : C.text2, fontWeight: 500, background: copied ? C.accBg : C.card, cursor: "pointer", fontFamily: "inherit" }}>
                {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Скопировано" : "Копировать"}
              </button>
              <button onClick={handleDownloadTxt} title="Скачать TXT"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text2, fontWeight: 500, background: C.card, cursor: "pointer", fontFamily: "inherit" }}>
                <FileText size={13} />TXT
              </button>
            </>
          )}
          {(t.status === "failed" || t.status === "partial") && (
            <button onClick={() => onRetry(t.id, { onError: (e) => showErr(e instanceof Error ? e.message : "Не удалось перезапустить") })}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, fontWeight: 500, background: C.card, cursor: "pointer", fontFamily: "inherit" }}>
              <RefreshCw size={13} />Повторить
            </button>
          )}
          <button onClick={() => {
            if (!window.confirm(`Удалить «${t.filename}»? Файл и расшифровка будут удалены безвозвратно.`)) return;
            onDelete(t.id, {
              onSuccess: onDeleteOk,
              onError: (e) => showErr(e instanceof Error ? e.message : "Ошибка удаления"),
            });
          }}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text2, fontWeight: 500, background: C.card, cursor: "pointer", fontFamily: "inherit" }}>
            <Trash2 size={13} />Удалить
          </button>
        </div>
      </div>

      {/* Audio player */}
      {(t.status === "completed" || t.status === "partial") && (
        <div style={{ padding: "12px 22px", background: C.bg2, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          {audio.loading ? (
            <div style={{ padding: "10px 0", color: C.text3, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.acc, animation: "spin .9s linear infinite" }} />
              Загружаем аудио…
            </div>
          ) : audio.error ? (
            <div style={{ padding: "10px 0", color: C.err, fontSize: 13 }}>Ошибка загрузки аудио: {audio.error}</div>
          ) : audio.url ? (
            <audio ref={audioRef} src={audio.url} controls style={{ width: "100%", height: 40 }}
              onTimeUpdate={(e) => setCurrentSec(e.currentTarget.currentTime)}
            />
          ) : null}
        </div>
      )}

      {/* Body content */}
      {isBusy ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: C.bg2, padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 380 }}>
            <div style={{ width: 54, height: 54, margin: "0 auto 18px", borderRadius: "50%", border: `3px solid ${C.border}`, borderTopColor: C.acc, animation: "spin .9s linear infinite" }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              {t.status === "queued" ? "В очереди" : "Обработка в GigaAM"}
            </div>
            <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.6 }}>
              {t.gigaam_task_id
                ? `Опрашиваем GigaAM (task ${t.gigaam_task_id.slice(0, 8)}…). Можно закрыть страницу — результат появится в списке.`
                : "Файл загружен, ждём обработки. Worker отправит запрос в GigaAM в ближайшую секунду."}
            </div>
          </div>
        </div>
      ) : t.status === "failed" ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: C.bg2, padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 480 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: C.errBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <X size={26} color={C.err} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>Ошибка транскрибации</div>
            {t.error_message && (
              <div style={{ fontSize: 12.5, color: C.text2, lineHeight: 1.55, fontFamily: "'DM Mono', monospace", background: C.bg3, padding: "10px 14px", borderRadius: 8, marginTop: 12, textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {t.error_message}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div style={{ padding: "0 22px", background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 4, flexShrink: 0 }}>
            {([
              { id: "dialog" as const,    label: "Диалог по каналам", Icon: MessageCircle },
              { id: "analytics" as const, label: "Аналитика",         Icon: BarChart3 },
              { id: "ai" as const,        label: "AI-анализ",         Icon: Sparkles },
            ]).map((x) => (
              <button key={x.id} onClick={() => setTab(x.id)}
                style={{ padding: "12px 14px", background: "transparent", border: "none", borderBottom: `2px solid ${tab === x.id ? C.acc : "transparent"}`, color: tab === x.id ? C.text : C.text2, fontSize: 13.5, fontWeight: tab === x.id ? 600 : 500, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7, marginBottom: -1 }}>
                <x.Icon size={15} />{x.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === "dialog" && <DialogTab segments={t.segments ?? []} currentSec={currentSec} onSeek={seekTo} />}
          {tab === "analytics" && <AnalyticsTab transcriptId={t.id} />}
          {tab === "ai" && <AITab />}
        </>
      )}
    </>
  );
}

// ── Диалог-бабблы по каналам ─────────────────────────────────────────────

function DialogTab({ segments, currentSec, onSeek }: {
  segments: TranscriptSegment[];
  currentSec: number;
  onSeek: (ms: number) => void;
}) {
  if (segments.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: C.bg2 }}>
        <Empty Icon={FileText} title="Транскрипт пуст" sub="GigaAM не вернул сегментов. Возможно, в аудио нет речи." />
      </div>
    );
  }

  // Стабильный порядок каналов для left/right (первый канал — слева).
  const speakerOrder: string[] = [];
  for (const s of segments) {
    if (!speakerOrder.includes(s.speaker_ref)) speakerOrder.push(s.speaker_ref);
  }
  const sideOf = (ref: string): "left" | "right" => speakerOrder.indexOf(ref) % 2 === 0 ? "left" : "right";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px", background: C.bg2 }}>
      {segments.map((s) => {
        const side = sideOf(s.speaker_ref);
        const col = speakerColor(s.speaker_ref);
        const isActive = currentSec * 1000 >= s.start_ms && currentSec * 1000 <= s.end_ms;
        return (
          <div key={s.id} style={{
            display: "flex", justifyContent: side === "left" ? "flex-start" : "flex-end",
            marginBottom: 10,
          }}>
            <div onClick={() => onSeek(s.start_ms)} style={{
              maxWidth: "75%", display: "flex", flexDirection: "column",
              alignItems: side === "left" ? "flex-start" : "flex-end",
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6, marginBottom: 4,
                flexDirection: side === "left" ? "row" : "row-reverse",
              }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 600, color: col,
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: col }} />
                  {speakerLabel(s.speaker_ref)}
                </span>
                <span style={{ fontSize: 10.5, color: C.text3, fontFamily: "'DM Mono', monospace" }}>
                  {fmtSeg(s.start_ms)} → {fmtSeg(s.end_ms)}
                </span>
              </div>
              <div style={{
                background: isActive ? `${col}1A` : C.card,
                border: `1px solid ${isActive ? col : C.border}`,
                borderRadius: 12,
                padding: "10px 14px",
                fontSize: 14, color: C.text, lineHeight: 1.55,
                cursor: "pointer",
                transition: "background .15s, border-color .15s",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {s.text || <span style={{ color: C.text3, fontStyle: "italic" }}>(пусто)</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Аналитика ─────────────────────────────────────────────────────────────

function AnalyticsTab({ transcriptId }: { transcriptId: string }) {
  const a = useTranscriptAnalytics(transcriptId);

  if (a.isLoading) return <div style={{ padding: 24, color: C.text3, fontSize: 13 }}>Считаем статистику…</div>;
  if (a.isError || !a.data) return <div style={{ padding: 24, color: C.err, fontSize: 13 }}>Ошибка: {String(a.error)}</div>;

  const data = a.data;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", background: C.bg2 }}>
      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
        <KpiCard Icon={Clock}        label="Длительность"  value={fmtSeg(data.total_duration_ms)}   color={C.acc} />
        <KpiCard Icon={MessageCircle} label="Сегментов"    value={data.segment_count}                color={C.purp} />
        <KpiCard Icon={FileText}     label="Слов"          value={data.word_count.toLocaleString("ru-RU")} color={C.ok} />
        <KpiCard Icon={AlertTriangle} label="Перебиваний"  value={data.interruptions}                color={data.interruptions > 5 ? C.warn : C.text2} />
      </div>

      {/* Speakers */}
      <Section title="Говорящие" sub={`${data.speakers.length} канал(а/ов) · по talk time`}>
        {data.speakers.length === 0
          ? <div style={{ color: C.text3, fontSize: 13 }}>Нет данных</div>
          : data.speakers.map((s) => (
            <div key={s.speaker} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 0", borderBottom: `1px dashed ${C.border}` }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: speakerColor(s.speaker), flexShrink: 0 }} />
              <div style={{ minWidth: 110, flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.label}</div>
                <div style={{ fontSize: 11, color: C.text3 }}>{s.segments} сегм. · {s.words} слов</div>
              </div>
              <div style={{ flex: 1, minWidth: 100 }}>
                <div style={{ height: 8, background: C.bg3, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${s.talk_ratio_pct}%`, height: "100%", background: speakerColor(s.speaker) }} />
                </div>
              </div>
              <div style={{ minWidth: 80, textAlign: "right", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>
                {fmtSeg(s.talk_time_ms)} <span style={{ color: C.text3 }}>· {s.talk_ratio_pct.toFixed(1)}%</span>
              </div>
            </div>
          ))}
      </Section>

      {/* Silence */}
      <Section title="Тишина" sub={`Паузы длиннее ${data.silence_threshold_ms / 1000}с между сегментами`}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: C.text3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Суммарно</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.text, marginTop: 4, fontFamily: "'DM Mono', monospace" }}>{fmtSeg(data.silence_total_ms)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.text3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Самая длинная</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.text, marginTop: 4, fontFamily: "'DM Mono', monospace" }}>{fmtSeg(data.longest_silence_ms)}</div>
          </div>
        </div>
      </Section>

      {/* Top words */}
      {data.top_words.length > 0 && (
        <Section title="Часто звучали" sub="После фильтра стоп-слов и нормализации">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.top_words.map((w) => {
              const max = data.top_words[0]!.count;
              const intensity = 0.4 + 0.6 * (w.count / max);
              return (
                <span key={w.word} style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 11px", borderRadius: 999,
                  background: `rgba(30, 90, 168, ${intensity * 0.18})`,
                  color: C.text, fontSize: 13, fontWeight: 500,
                  border: `1px solid ${C.border}`,
                }}>
                  {w.word}
                  <span style={{ color: C.text3, fontSize: 11, fontFamily: "'DM Mono', monospace" }}>{w.count}</span>
                </span>
              );
            })}
          </div>
        </Section>
      )}

      {/* Emotions */}
      <Section title="Эмоции" sub={data.emotions ? "GigaAM emotion model" : "Не доступны (EMO модель выключена на инстансе GigaAM)"}>
        {!data.emotions ? (
          <div style={{ color: C.text3, fontSize: 13 }}>—</div>
        ) : data.emotions.overall ? (
          <EmotionBars emo={data.emotions.overall} label="Общий тон" />
        ) : data.emotions.channels && data.emotions.channels.length > 0 ? (
          data.emotions.channels.map((ch) => (
            <div key={ch.channel} style={{ marginBottom: 14 }}>
              <EmotionBars emo={ch.emotions} label={`Канал ${ch.channel}`} colorRef={`channel:${ch.channel}`} />
            </div>
          ))
        ) : null}
      </Section>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: C.text2, marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ padding: "14px 18px" }}>{children}</div>
    </div>
  );
}

function EmotionBars({ emo, label, colorRef }: {
  emo: { angry: number; sad: number; neutral: number; positive: number };
  label?: string;
  colorRef?: string;
}) {
  const items = [
    { key: "positive", label: "Позитив",  Icon: Smile, val: emo.positive, col: C.ok },
    { key: "neutral",  label: "Нейтрал.", Icon: Meh,   val: emo.neutral,  col: C.text2 },
    { key: "sad",      label: "Грусть",   Icon: Frown, val: emo.sad,      col: C.acc },
    { key: "angry",    label: "Злость",   Icon: AlertTriangle, val: emo.angry, col: C.err },
  ];
  return (
    <div>
      {label && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          {colorRef && <span style={{ width: 8, height: 8, borderRadius: "50%", background: speakerColor(colorRef) }} />}
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text2 }}>{label}</div>
        </div>
      )}
      {items.map((it) => (
        <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
          <it.Icon size={13} color={it.col} />
          <div style={{ minWidth: 75, fontSize: 12, color: C.text2 }}>{it.label}</div>
          <div style={{ flex: 1, height: 6, background: C.bg3, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${it.val * 100}%`, height: "100%", background: it.col }} />
          </div>
          <div style={{ minWidth: 50, textAlign: "right", fontSize: 12, color: C.text, fontFamily: "'DM Mono', monospace" }}>
            {(it.val * 100).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  );
}

// ── AI-раздел (стаб для v1.4 LLM-суммаризации) ────────────────────────────

function AITab() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px", background: C.bg2 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.purpBg} 0%, ${C.accBg} 100%)`, border: `1px solid ${C.accBrd}`, borderRadius: 14, padding: "22px 24px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Sparkles size={20} color={C.purp} />
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.text }}>AI-анализ</h3>
          <Bdg v="warn">v1.4 · в разработке</Bdg>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 13.5, color: C.text2, lineHeight: 1.55 }}>
          После подключения LLM-суммаризации (роадмап v1.4) в этом разделе появится:
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <AIFeatureCard Icon={FileText} title="Краткое резюме"
          desc="Что обсуждалось, кто что сказал, к чему пришли — за 3-5 предложений." />
        <AIFeatureCard Icon={Hash} title="Ключевые темы"
          desc="Автовыделение тем разговора, упомянутых продуктов, имён, дат." />
        <AIFeatureCard Icon={Check} title="Action items"
          desc="Договорённости и задачи, явно проговорённые сторонами, с возможной отправкой в Bitrix24." />
        <AIFeatureCard Icon={Users} title="Резюме клиента"
          desc="Профиль контрагента: тон, лояльность, проблемы — для следующего звонка." />
        <AIFeatureCard Icon={Shield} title="Compliance"
          desc="Сигналы о нарушениях скрипта, упоминаниях запрещённых тем, рисках." />
        <AIFeatureCard Icon={MessageSquare} title="Q&A по транскрипту"
          desc="Чат с моделью: «о чём говорили на 5-й минуте?», «что обещал клиент?»" />
      </div>
    </div>
  );
}

function AIFeatureCard({ Icon, title, desc }: { Icon: LucideIcon; title: string; desc: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: C.purpBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={16} color={C.purp} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
      </div>
      <div style={{ fontSize: 12.5, color: C.text2, lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ──────────────────────────────────────────────────────────────────────────

function KpiCard({ Icon, label, value, color, sub }: { Icon: LucideIcon; label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 42, height: 42, borderRadius: 12, background: `${color}1A`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={18} color={color} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, color: C.text3, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginTop: 2, letterSpacing: "-0.01em" }}>{value}</div>
        {sub && <div style={{ fontSize: 11.5, color: C.text2, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
      </div>
    </div>
  );
}

function ActionBtn({ Icon, title, danger }: { Icon: LucideIcon; title: string; danger?: boolean }) {
  return (
    <button title={title}
      style={{ width: 30, height: 30, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.border}`, background: C.card, color: C.text2, cursor: "pointer", transition: "all .12s" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? C.errBg : C.accBg; e.currentTarget.style.color = danger ? C.err : C.acc; e.currentTarget.style.borderColor = danger ? C.errBrd : C.accBrd; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = C.card; e.currentTarget.style.color = C.text2; e.currentTarget.style.borderColor = C.border; }}>
      <Icon size={13} />
    </button>
  );
}

function SlaBadge({ value }: { value: number }) {
  const col = value >= 90 ? C.ok : value >= 80 ? C.warn : C.err;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, color: col, fontWeight: 600, fontFamily: "'DM Mono', monospace", minWidth: 34 }}>{value}%</span>
      <div style={{ width: 50, height: 5, borderRadius: 3, background: C.bg3, overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: col, borderRadius: 3 }} />
      </div>
    </div>
  );
}

type ExtState = "idle" | "ringing" | "oncall" | "hold" | "dnd" | "offline";
type ExtRow = {
  ext: number; name: string; av: string; col: string; state: ExtState;
  peer?: string; duration?: number; direction?: "in" | "out"; queue?: string; internal?: boolean;
};

function AnalyticsPage() {
  const [tab, setTab] = useState<"monitoring" | "metrics">("monitoring");
  const [range, setRange] = useState("today");

  // Состояния extensions из FreePBX AMI — пока endpoint не реализован,
  // массив пустой, и шаблон показывает Empty-state.
  const [exts, setExts] = useState<ExtRow[]>([]);

  useEffect(() => {
    const iv = setInterval(() => {
      setExts((es) => es.map((e) =>
        (e.state === "oncall" || e.state === "hold") && typeof e.duration === "number"
          ? { ...e, duration: e.duration + 1 }
          : e
      ));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const stateMeta: Record<ExtState, { label: string; col: string; bdg: BdgVariant }> = {
    idle:    { label: "Онлайн",        col: C.ok,    bdg: "ok"   },
    ringing: { label: "Входящий",      col: C.warn,  bdg: "warn" },
    oncall:  { label: "В разговоре",   col: C.err,   bdg: "err"  },
    hold:    { label: "Удержание",     col: C.warn,  bdg: "warn" },
    dnd:     { label: "Не беспокоить", col: C.err,   bdg: "err"  },
    offline: { label: "Офлайн",        col: C.text3, bdg: "def"  },
  };

  const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const fmtSecLong = (s: number) => {
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };

  const online  = exts.filter((e) => e.state !== "offline").length;
  const onCall  = exts.filter((e) => e.state === "oncall").length;
  const ringing = exts.filter((e) => e.state === "ringing").length;
  const busy    = exts.filter((e) => e.state === "oncall" || e.state === "hold").length;
  const dnd     = exts.filter((e) => e.state === "dnd").length;
  const load    = online ? Math.round(busy / online * 100) : 0;

  // Очереди FreePBX и метрики операторов — придут с backend позже.
  const queues: { name: string; waiting: number; agents: number; answered: number; avgWait: number; sla: number }[] = [];
  const metrics: { name: string; av: string; col: string; answered: number; outgoing: number; missed: number; avgDur: number; totalTalk: number; sla: number }[] = [];

  const totals = {
    answered:  metrics.reduce((s, m) => s + m.answered, 0),
    outgoing:  metrics.reduce((s, m) => s + m.outgoing, 0),
    missed:    metrics.reduce((s, m) => s + m.missed, 0),
    totalTalk: metrics.reduce((s, m) => s + m.totalTalk, 0),
  };
  const totalCalls = totals.answered + totals.outgoing + totals.missed;
  const answerRate = totalCalls ? Math.round((totals.answered + totals.outgoing) / totalCalls * 100) : 0;
  const avgSla = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.sla, 0) / metrics.length) : 0;
  const avgDur = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.avgDur, 0) / metrics.length) : 0;

  return (
    <div style={{ minHeight: "100%", background: C.bg2 }}>
      <style>{`@keyframes anPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.45)}70%{box-shadow:0 0 0 7px rgba(245,158,11,0)}}`}</style>
      <PgHdr title="Мониторинг АТС" sub="FreePBX через AMI · оперативные метрики, регистрации, активные каналы" />

      <div style={{ padding: "0 24px", background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 4 }}>
        {([{ id: "monitoring" as const, label: "Мониторинг", Icon: Activity },
           { id: "metrics" as const,    label: "Метрики сотрудников", Icon: BarChart3 }]).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: "12px 14px", background: "transparent", border: "none", borderBottom: `2px solid ${tab === t.id ? C.acc : "transparent"}`, color: tab === t.id ? C.text : C.text2, fontSize: 13.5, fontWeight: tab === t.id ? 600 : 500, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7, marginBottom: -1 }}>
            <t.Icon size={15} />{t.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {tab === "monitoring" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: C.text2 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.ok, animation: "anPulse 2s infinite" }} />
            Обновление в реальном времени
          </div>
        ) : (
          <select value={range} onChange={(e) => setRange(e.target.value)}
            style={{ padding: "6px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12.5, color: C.text, background: C.card, cursor: "pointer", fontFamily: "inherit" }}>
            <option value="today">Сегодня</option>
            <option value="week">7 дней</option>
            <option value="month">30 дней</option>
            <option value="quarter">Квартал</option>
          </select>
        )}
      </div>

      {tab === "monitoring" ? (
        <div style={{ padding: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
            <KpiCard Icon={Phone}    label="Активных звонков" value={onCall} color={C.err}  sub={ringing > 0 ? `+ ${ringing} входящих` : "все под контролем"} />
            <KpiCard Icon={Clock}    label="В очереди"        value={queues.reduce((s, q) => s + q.waiting, 0)} color={C.warn} sub="средн. ожидание 23 сек" />
            <KpiCard Icon={Users}    label="Операторов онлайн" value={`${online} / ${exts.length}`} color={C.ok} sub={`${dnd} в DND · ${exts.length - online} офлайн`} />
            <KpiCard Icon={Activity} label="Загрузка АТС"     value={`${load}%`} color={C.acc} sub={`${busy} из ${online} на линии`} />
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "13px 18px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Внутренние номера</div>
              <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{exts.length} номеров · состояния из AMI</div>
            </div>
            {exts.length === 0 ? (
              <Empty Icon={Phone}
                title="Нет данных по extensions"
                sub="Подключение к FreePBX AMI не настроено или АТС не возвращает события. Проверьте настройки телефонии в админ-панели." />
            ) : <div>
              {exts.map((e) => {
                const m = stateMeta[e.state];
                const isBusy = e.state === "oncall" || e.state === "hold";
                const isRinging = e.state === "ringing";
                return (
                  <div key={e.ext}
                    style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = C.bg2; const a = ev.currentTarget.querySelector('.ext-actions') as HTMLElement | null; if (a) a.style.opacity = "1"; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = "transparent"; const a = ev.currentTarget.querySelector('.ext-actions') as HTMLElement | null; if (a) a.style.opacity = "0"; }}>
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <Av i={e.av} c={e.col} sz={34} />
                      <span style={{ position: "absolute", bottom: -1, right: -1, width: 11, height: 11, borderRadius: "50%", background: m.col, border: `2px solid ${C.card}`, boxSizing: "content-box", animation: isRinging ? "anPulse 1.3s infinite" : "none" }} />
                    </div>
                    <div style={{ minWidth: 170, flexShrink: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: C.text }}>{e.name}</div>
                      <div style={{ fontSize: 11.5, color: C.text3, fontFamily: "'DM Mono', monospace", marginTop: 1 }}>#{e.ext}</div>
                    </div>
                    <Bdg v={m.bdg}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.col }} />
                      {m.label}
                    </Bdg>
                    {isBusy && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.text2 }}>
                        <span style={{ fontFamily: "'DM Mono', monospace", color: C.text, fontWeight: 500 }}>{e.peer}</span>
                        {e.queue && <Bdg>«{e.queue}»</Bdg>}
                        <span style={{ fontFamily: "'DM Mono', monospace", color: e.state === "hold" ? C.warn : C.err, fontWeight: 500 }}>{fmtSecLong(e.duration ?? 0)}</span>
                      </div>
                    )}
                    {isRinging && (
                      <div style={{ fontSize: 12.5, color: C.warnTx, fontWeight: 500 }}>
                        <span style={{ fontFamily: "'DM Mono', monospace" }}>{e.peer}</span>
                        <span style={{ marginLeft: 6, color: C.text3, fontWeight: 400 }}>звонит…</span>
                      </div>
                    )}
                    <div style={{ flex: 1 }} />
                    {(isBusy || isRinging) && (
                      <div className="ext-actions" style={{ display: "flex", gap: 4, opacity: 0, transition: "opacity .12s", flexShrink: 0 }}>
                        <ActionBtn Icon={Headphones}     title="Слушать разговор" />
                        <ActionBtn Icon={Mic}            title="Суфлировать (шёпот)" />
                        <ActionBtn Icon={ArrowRightLeft} title="Перехватить вызов" />
                        <ActionBtn Icon={PhoneOff}       title="Завершить вызов" danger />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "13px 18px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Очереди</div>
              <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>Распределение входящих звонков</div>
            </div>
            {queues.length === 0 ? (
              <Empty Icon={Clock} title="Очереди не настроены" sub="После настройки очередей FreePBX данные появятся здесь автоматически." />
            ) : <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead>
                  <tr style={{ background: C.bg2 }}>
                    {["Очередь", "В ожидании", "Агентов", "Отвечено", "Ср. время ожидания", "SLA"].map((h) => (
                      <th key={h} style={{ padding: "9px 18px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queues.map((q) => (
                    <tr key={q.name} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: "11px 18px", fontSize: 13.5, fontWeight: 500, color: C.text }}>{q.name}</td>
                      <td style={{ padding: "11px 18px" }}>
                        {q.waiting === 0 ? <span style={{ fontSize: 13, color: C.text3 }}>—</span>
                          : <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: C.warnTx }}>
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.warn, animation: "anPulse 1.5s infinite" }} />
                            {q.waiting}
                          </span>}
                      </td>
                      <td style={{ padding: "11px 18px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{q.agents}</td>
                      <td style={{ padding: "11px 18px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{q.answered}</td>
                      <td style={{ padding: "11px 18px", fontSize: 13, color: C.text2, fontFamily: "'DM Mono', monospace" }}>{q.avgWait} сек</td>
                      <td style={{ padding: "11px 18px" }}><SlaBadge value={q.sla} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
          </div>
        </div>
      ) : (
        <div style={{ padding: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
            <KpiCard Icon={Phone}  label="Всего звонков"     value={totalCalls.toLocaleString("ru-RU")} color={C.acc}  sub={`${totals.answered} входящ · ${totals.outgoing} исходящ`} />
            <KpiCard Icon={Check}  label="Отвеченных"        value={`${answerRate}%`} color={C.ok}  sub={`${totals.missed} пропущено`} />
            <KpiCard Icon={Clock}  label="Ср. длительность"  value={fmtSec(avgDur)} color={C.warn} sub="на один звонок" />
            <KpiCard Icon={Shield} label="SLA"               value={`${avgSla}%`} color={avgSla >= 90 ? C.ok : avgSla >= 80 ? C.warn : C.err} sub="ответ ≤ 30 сек" />
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "13px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Метрики сотрудников</div>
                <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>Данные за выбранный период · {metrics.length} операторов</div>
              </div>
              <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, fontWeight: 500, background: C.card, cursor: "pointer", fontFamily: "inherit" }}>
                <Download size={13} />Экспорт CSV
              </button>
            </div>
            {metrics.length === 0 ? (
              <Empty Icon={BarChart3}
                title="Метрики операторов недоступны"
                sub="Появятся когда CDR-импорт из FreePBX начнёт собирать историю звонков." />
            ) : <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
                <thead>
                  <tr style={{ background: C.bg2 }}>
                    {["Сотрудник", "Отвечено", "Исходящих", "Пропущено", "Ср. длит.", "Время в разговоре", "SLA"].map((h) => (
                      <th key={h} style={{ padding: "9px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.name} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: "11px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <Av i={m.av} c={m.col} sz={28} />
                          <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{m.name}</span>
                        </div>
                      </td>
                      <td style={{ padding: "11px 16px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{m.answered}</td>
                      <td style={{ padding: "11px 16px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{m.outgoing}</td>
                      <td style={{ padding: "11px 16px" }}>
                        {m.missed > 0
                          ? <span style={{ fontSize: 13, color: C.err, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{m.missed}</span>
                          : <span style={{ fontSize: 13, color: C.text3 }}>—</span>}
                      </td>
                      <td style={{ padding: "11px 16px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{fmtSec(m.avgDur)}</td>
                      <td style={{ padding: "11px 16px", fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace" }}>{fmtSecLong(m.totalTalk)}</td>
                      <td style={{ padding: "11px 16px" }}><SlaBadge value={m.sla} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// USERS, PHONE SETTINGS, SMTP SETTINGS — admin pages
// ──────────────────────────────────────────────────────────────────────────

function UsersPage({ hideHeader }: { hideHeader?: boolean }) {
  const list = useAdminUsers();
  const [q, setQ] = useState("");
  const all = list.data ?? [];
  const filt = all.filter((u) => {
    const s = q.toLowerCase();
    return !s ||
      u.full_name.toLowerCase().includes(s) ||
      u.email.toLowerCase().includes(s) ||
      (u.department || "").toLowerCase().includes(s) ||
      (u.extension || "").toLowerCase().includes(s);
  });
  const fmtLogin = (iso?: string) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const ago = Date.now() - d.getTime();
    if (ago < 60_000) return "только что";
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} мин. назад`;
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} ч. назад`;
    return d.toLocaleDateString("ru-RU");
  };

  return (
    <div style={{ minHeight: "100%", background: C.bg2 }}>
      {!hideHeader && (
        <PgHdr title="Пользователи"
          sub={list.isLoading ? "Загрузка…" : `${all.length} ${all.length === 1 ? "сотрудник" : "сотрудников"}`} />
      )}
      <div style={{ padding: 24 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={14} color={C.text3} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени, email, отделу или внутреннему номеру…"
              style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: C.text, background: "transparent", fontFamily: "inherit" }} />
          </div>
          {list.isError ? (
            <Empty Icon={Users} title="Не удалось загрузить" sub={String(list.error)} />
          ) : list.isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: C.text3, fontSize: 13 }}>Загрузка…</div>
          ) : filt.length === 0 ? (
            <Empty Icon={Users} title={q ? "Никого не найдено" : "Пользователей ещё нет"}
              sub={q ? "Попробуйте изменить запрос" : "Сотрудники появятся здесь после первого входа в Toolkit через Bitrix24."} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
                <thead>
                  <tr style={{ background: C.bg2 }}>
                    {["Сотрудник", "Email", "Отдел", "Должность", "Номер", "Роль", "Статус", "Последний вход"].map((h) => (
                      <th key={h} style={{ padding: "9px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filt.map((u) => {
                    const initials = (u.full_name || u.email).split(/\s+/).map((p) => p[0] || "").slice(0, 2).join("").toUpperCase();
                    return (
                      <tr key={u.id} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "11px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            <Av i={initials} sz={32} src={u.avatar_url} />
                            <div>
                              <div style={{ fontSize: 13.5, fontWeight: 500, color: C.text }}>{u.full_name || "—"}</div>
                              <div style={{ fontSize: 11, color: C.text3, fontFamily: "'DM Mono', monospace" }}>Bitrix #{u.bitrix_id}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: "11px 16px", fontSize: 13, color: C.text }}>{u.email}</td>
                        <td style={{ padding: "11px 16px", fontSize: 13, color: C.text2 }}>{u.department || "—"}</td>
                        <td style={{ padding: "11px 16px", fontSize: 13, color: C.text2 }}>{u.position || "—"}</td>
                        <td style={{ padding: "11px 16px" }}>
                          {u.extension ? <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 600, color: C.text }}>#{u.extension}</span>
                            : <span style={{ fontSize: 12, color: C.text3, fontStyle: "italic" }}>не назначен</span>}
                        </td>
                        <td style={{ padding: "11px 16px" }}>
                          <Bdg v={u.is_admin ? "adm" : "def"}>{u.is_admin ? "Администратор" : "Пользователь"}</Bdg>
                        </td>
                        <td style={{ padding: "11px 16px" }}>
                          <Bdg v={u.status === "active" ? "ok" : "err"}>{u.status === "active" ? "Активен" : "Заблокирован"}</Bdg>
                        </td>
                        <td style={{ padding: "11px 16px", fontSize: 12, color: C.text3 }}>{fmtLogin(u.last_login_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// PhoneSettingsPage — настройки телефонии: 2 вкладки.
//   • WebRTC шлюз — WSS-подключение к FreePBX + внутренние номера
//   • AMI         — Asterisk Manager Interface для мониторинга АТС/CDR
function PhoneSettingsPage({ hideHeader }: { hideHeader?: boolean } = {}) {
  const [tab, setTab] = useState<"webrtc" | "ami">("webrtc");
  const tabs = [
    { id: "webrtc" as const, label: "WebRTC шлюз", Icon: Phone },
    { id: "ami"    as const, label: "AMI (мониторинг)", Icon: Activity },
  ];

  return (
    <div style={{ minHeight: "100%", background: C.bg2, display: "flex", flexDirection: "column" }}>
      {!hideHeader && (
        <PgHdr title="Настройки телефонии" sub="FreePBX · WebRTC-шлюз и AMI для мониторинга" />
      )}
      <div style={{ padding: "0 24px", background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 4, flexShrink: 0 }}>
        {tabs.map((x) => (
          <button key={x.id} onClick={() => setTab(x.id)}
            style={{
              padding: "12px 14px", background: "transparent", border: "none",
              borderBottom: `2px solid ${tab === x.id ? C.acc : "transparent"}`,
              color: tab === x.id ? C.text : C.text2,
              fontSize: 13.5, fontWeight: tab === x.id ? 600 : 500,
              cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 7, marginBottom: -1,
            }}>
            <x.Icon size={15} />{x.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "webrtc" && <PhoneWebrtcTab />}
        {tab === "ami"    && <PhoneAmiTab />}
      </div>
    </div>
  );
}

function PhoneWebrtcTab() {
  const [saved, setSaved] = useState(false);
  const [freeNums, setFreeNums] = useState<{ ext: string; pwd: string; saved: boolean }[]>([]);
  const [assigned] = useState<unknown[]>([]);
  const [newExt, setNewExt] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const addFree = () => {
    if (!newExt.trim() || !newPwd.trim()) return;
    setFreeNums((f) => [{ ext: newExt.trim(), pwd: newPwd, saved: true }, ...f]);
    setNewExt(""); setNewPwd("");
  };
  const updFreePwd = (i: number, v: string) => setFreeNums((f) => f.map((x, idx) => idx === i ? { ...x, pwd: v, saved: false } : x));
  const saveFree = (i: number) => setFreeNums((f) => f.map((x, idx) => idx === i ? { ...x, saved: true } : x));
  const editFree = (i: number) => setFreeNums((f) => f.map((x, idx) => idx === i ? { ...x, saved: false } : x));
  const rmFree = (i: number) => setFreeNums((f) => f.filter((_, idx) => idx !== i));

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button onClick={save} style={{ display: "flex", alignItems: "center", gap: 7, background: saved ? C.acc : C.text, color: "white", padding: "9px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          {saved ? <><Check size={15} />Сохранено</> : <><Save size={15} />Сохранить</>}
        </button>
      </div>
      <SettingsSection title="Подключение к FreePBX" sub="WSS-сигнализация WebRTC, шлюз для браузерного софтфона">
        <Field label="WSS-адрес шлюза"><input placeholder="wss://pbx.example.com:8089/ws" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
        <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.text, background: C.card, cursor: "pointer", fontFamily: "inherit", marginTop: 4, fontWeight: 500 }}>
          <Phone size={13} />Тестовый звонок
        </button>
      </SettingsSection>

      <SettingsSection title="Внутренние номера" sub="Привязка extension'ов FreePBX к пользователям Toolkit">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: `1px dashed ${C.border}` }}>
          <input value={newExt} onChange={(e) => setNewExt(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => { if (e.key === "Enter") addFree(); }}
            placeholder="Номер (напр. 1012)" style={{ width: 150, padding: "8px 11px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "'DM Mono', monospace", color: C.text, outline: "none", background: C.card }} />
          <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFree(); }}
            placeholder="Пароль*" style={{ flex: 1, minWidth: 140, padding: "8px 11px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "'DM Mono', monospace", color: C.text, outline: "none", background: C.card }} />
          <button onClick={addFree} disabled={!newExt.trim() || !newPwd.trim()}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 7, border: "none", background: (newExt.trim() && newPwd.trim()) ? C.acc : C.bg3, color: (newExt.trim() && newPwd.trim()) ? "white" : C.text3, fontSize: 13, fontWeight: 600, cursor: (newExt.trim() && newPwd.trim()) ? "pointer" : "default", fontFamily: "inherit" }}>
            <Save size={14} />Сохранить
          </button>
        </div>

        {freeNums.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              Свободные номера · {freeNums.length}
            </div>
            {freeNums.map((n, i) => {
              const miss = !n.pwd.trim();
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: C.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Hash size={13} color={C.text2} />
                  </div>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: C.text }}>#{n.ext}</span>
                  <input type="password" value={n.pwd} onChange={(e) => updFreePwd(i, e.target.value)} disabled={n.saved} placeholder="Пароль*"
                    style={{ width: 130, padding: "5px 8px", border: `1px solid ${miss ? C.err : C.border}`, borderRadius: 6, fontSize: 12, fontFamily: "'DM Mono', monospace", color: C.text, outline: "none", background: n.saved ? C.bg3 : C.card, filter: n.saved ? "blur(2.5px)" : "none" }} />
                  {n.saved ? (
                    <button onClick={() => editFree(i)} title="Изменить пароль" style={{ width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", cursor: "pointer", color: C.text2, border: `1px solid ${C.border}` }}>
                      <Edit2 size={13} />
                    </button>
                  ) : (
                    <button onClick={() => saveFree(i)} disabled={miss} title="Сохранить пароль" style={{ width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: miss ? C.bg3 : C.acc, color: miss ? C.text3 : "white", cursor: miss ? "default" : "pointer", border: "none" }}>
                      <Check size={14} />
                    </button>
                  )}
                  <button onClick={() => rmFree(i)} title="Удалить номер" style={{ width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", cursor: "pointer", color: C.text3, border: "none" }}>
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {freeNums.length === 0 && assigned.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: C.text3 }}>
            <Hash size={20} style={{ marginBottom: 8 }} />
            <div style={{ fontSize: 12.5, color: C.text2, fontWeight: 500 }}>Номера не созданы</div>
            <div style={{ fontSize: 11.5, color: C.text3, marginTop: 3, lineHeight: 1.5 }}>Добавьте первый номер из FreePBX в поле выше</div>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function PhoneAmiTab() {
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [testSt, setTestSt] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const test = () => {
    setTestSt("checking");
    setTimeout(() => setTestSt("fail"), 1400); // mock — реальная проверка появится с интеграцией AMI
  };

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button onClick={save} style={{ display: "flex", alignItems: "center", gap: 7, background: saved ? C.acc : C.text, color: "white", padding: "9px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          {saved ? <><Check size={15} />Сохранено</> : <><Save size={15} />Сохранить</>}
        </button>
      </div>

      <SettingsSection title="Asterisk Manager Interface (AMI)"
        sub="Прямое TCP-подключение к Asterisk для мониторинга АТС: список регистраций, активные каналы, история CDR. Не используется для звонков — только наблюдение.">
        <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${enabled ? C.acc : C.border}`, borderRadius: 10, cursor: "pointer", background: enabled ? C.accBg : C.card, marginBottom: 14 }}>
          <div style={{ position: "relative", width: 36, height: 20, background: enabled ? C.acc : C.border2, borderRadius: 10, flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 2, left: enabled ? 18 : 2, width: 16, height: 16, background: "white", borderRadius: "50%", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
          </div>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ display: "none" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>Включить интеграцию AMI</div>
            <div style={{ fontSize: 12, color: C.text2, marginTop: 2, lineHeight: 1.4 }}>Без этой галочки модуль «Мониторинг АТС» не будет получать данные от Asterisk.</div>
          </div>
        </label>

        <Field label="Хост"><input placeholder="pbx.example.com или IP" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} disabled={!enabled} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, marginBottom: 14 }}>
          <div>
            <Lbl>Порт</Lbl>
            <input defaultValue="5038" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} disabled={!enabled} />
          </div>
          <div>
            <Lbl>Пользователь AMI</Lbl>
            <input placeholder="toolkit-monitor" style={inp()} disabled={!enabled} />
          </div>
        </div>
        <Field label="Секрет (manager.conf → secret)"><input type="password" placeholder="••••••••" style={inp()} disabled={!enabled} /></Field>
      </SettingsSection>

      <SettingsSection title="Проверка подключения" sub="Подключиться к AMI и прочитать `Action: Ping`">
        <button onClick={test} disabled={!enabled || testSt === "checking"}
          style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: testSt === "ok" ? C.accBg : C.card, color: testSt === "ok" ? C.accTx : C.text, fontSize: 13, fontWeight: 500, cursor: enabled && testSt !== "checking" ? "pointer" : "default", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, opacity: enabled ? 1 : 0.55 }}>
          {testSt === "checking" ? <><RefreshCw size={14} className="lk-spin" />Проверяем…</>
            : testSt === "ok" ? <><Check size={14} />Соединение ОК</>
            : testSt === "fail" ? <><AlertCircle size={14} color={C.err} />Не удалось подключиться</>
            : <><Wifi size={14} />Проверить связь</>}
        </button>
        {testSt === "fail" && (
          <div style={{ marginTop: 10, fontSize: 12, color: C.text2, lineHeight: 1.5 }}>
            Заглушка теста: реальная проверка появится после подключения AMI. Сейчас сохраняется только конфигурация.
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

// SettingsSection — карточка раздела для PhoneSettings/SmtpSettings/AISettings.
function SettingsSection({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ padding: "18px 20px" }}>{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SYSTEM SETTINGS — единая админ-страница с табами
// (Пользователи / Телефония / SMTP / AI)
// ──────────────────────────────────────────────────────────────────────────

type SettingsTab = "users" | "modules" | "phone" | "smtp" | "ai";

function SystemSettingsPage(_: { users?: MockUser[] }) {
  const [tab, setTab] = useState<SettingsTab>("users");

  const tabs: { id: SettingsTab; label: string; Icon: LucideIcon }[] = [
    { id: "users",   label: "Пользователи",     Icon: User },
    { id: "modules", label: "Доступ к модулям", Icon: Shield },
    { id: "phone",   label: "Телефония",        Icon: Phone },
    { id: "smtp",    label: "SMTP",             Icon: Send },
    { id: "ai",      label: "AI",               Icon: Sparkles },
  ];

  return (
    <div style={{ minHeight: "100%", background: C.bg2, display: "flex", flexDirection: "column" }}>
      <PgHdr title="Настройки системы" sub="Пользователи · Доступ к модулям · Телефония · SMTP · AI" />
      <div style={{ padding: "0 24px", background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 4, flexShrink: 0 }}>
        {tabs.map((x) => (
          <button key={x.id} onClick={() => setTab(x.id)}
            style={{
              padding: "12px 14px", background: "transparent", border: "none",
              borderBottom: `2px solid ${tab === x.id ? C.acc : "transparent"}`,
              color: tab === x.id ? C.text : C.text2,
              fontSize: 13.5, fontWeight: tab === x.id ? 600 : 500,
              cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 7, marginBottom: -1,
            }}>
            <x.Icon size={15} />{x.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "users"   && <UsersPage hideHeader />}
        {tab === "modules" && <ModuleAccessPage />}
        {tab === "phone"   && <PhoneSettingsPage hideHeader />}
        {tab === "smtp"    && <SmtpSettingsPage hideHeader />}
        {tab === "ai"      && <AISettingsPage hideHeader />}
      </div>
    </div>
  );
}

// ModuleAccessPage — переключатели видимости модулей в основном меню для
// non-admin пользователей. Админы всегда видят всё (фильтр на стороне UI).
function ModuleAccessPage() {
  const q = useModuleAccess();
  const upd = useUpdateModuleAccess();
  const v = q.data;
  const [draft, setDraft] = useState<typeof v>(v);
  useEffect(() => { if (v) setDraft(v); }, [v]);

  if (!draft || !v) return <div style={{ padding: 40, textAlign: "center", color: C.text3 }}>Загрузка…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(v);
  const items: { key: keyof typeof draft; label: string; desc: string; Icon: LucideIcon }[] = [
    { key: "vcs",           label: "Видеоконференции", desc: "Создание и проведение встреч (LiveKit)", Icon: Video },
    { key: "transcription", label: "Транскрибация",    desc: "Расшифровка звонков и встреч (GigaAM)",  Icon: FileText },
    { key: "messengers",    label: "Мессенджеры",      desc: "WhatsApp / Telegram / внутренний чат",   Icon: MessageSquare },
    { key: "contacts",      label: "Контакты",         desc: "Справочник коллег и контрагентов",       Icon: Users },
    { key: "helpdesk",      label: "Хелпдэск",         desc: "Тикеты для ИТ / АХО / HR",               Icon: HelpCircle },
  ];

  const save = async () => {
    try { await upd.mutateAsync(draft); }
    catch (e) { alert("Не удалось сохранить: " + (e instanceof Error ? e.message : String(e))); }
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: C.text2, lineHeight: 1.5 }}>
          Выключенный модуль скрывается из меню для всех, кроме главного администратора.<br/>Доступ по прямой ссылке тоже блокируется (роуты на сервере не проверяют этот флаг — в первой версии скрытие только в UI).
        </div>
        <button onClick={() => void save()} disabled={!dirty || upd.isPending}
          style={{ display: "flex", alignItems: "center", gap: 7, background: dirty && !upd.isPending ? C.acc : C.bg3, color: dirty && !upd.isPending ? "white" : C.text3, padding: "9px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: dirty && !upd.isPending ? "pointer" : "default", fontFamily: "inherit", flexShrink: 0 }}>
          {upd.isPending ? <><RefreshCw size={15} className="lk-spin" />Сохраняем…</>
            : upd.isSuccess && !dirty ? <><Check size={15} />Сохранено</>
            : <><Save size={15} />Сохранить</>}
        </button>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        {items.map((it, i) => {
          const on = !!draft[it.key];
          return (
            <label key={it.key} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`, cursor: "pointer" }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: on ? C.accBg : C.bg3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <it.Icon size={17} color={on ? C.acc : C.text3} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{it.label}</div>
                <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{it.desc}</div>
              </div>
              <div style={{ position: "relative", width: 40, height: 22, background: on ? C.acc : C.border2, borderRadius: 11, flexShrink: 0, transition: "background .15s" }}>
                <div style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, background: "white", borderRadius: "50%", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
              </div>
              <input type="checkbox" checked={on} onChange={(e) => setDraft({ ...draft, [it.key]: e.target.checked })} style={{ display: "none" }} />
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// AI SETTINGS — провайдеры моделей (ASR / LLM) и параметры аналитики
// ──────────────────────────────────────────────────────────────────────────

function AISettingsPage({ hideHeader }: { hideHeader?: boolean } = {}) {
  const [saved, setSaved] = useState(false);
  const [asrProvider, setAsrProvider] = useState("gigaam");
  const [llmProvider, setLlmProvider] = useState("none");
  const [diarization, setDiarization] = useState(true);

  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const saveBtn = (
    <button onClick={save} style={{ display: "flex", alignItems: "center", gap: 7, background: saved ? C.acc : C.text, color: "white", padding: "9px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
      {saved ? <><Check size={15} />Сохранено</> : <><Save size={15} />Сохранить</>}
    </button>
  );

  const Sec = ({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) => (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ padding: "18px 20px" }}>{children}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100%", background: C.bg2 }}>
      {!hideHeader && (
        <PgHdr title="Настройки AI" sub="Провайдеры распознавания и языковых моделей" action={saveBtn} />
      )}
      <div style={{ padding: 24, maxWidth: 640 }}>
        {hideHeader && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>{saveBtn}</div>
        )}

        <Sec title="Распознавание речи (ASR)" sub="Провайдер для транскрибации звонков и встреч">
          <Field label="Провайдер">
            <select value={asrProvider} onChange={(e) => setAsrProvider(e.target.value)} style={{ ...inp(), cursor: "pointer" }}>
              <option value="gigaam">GigaAM (Сбер) — self-hosted</option>
              <option value="whisper">OpenAI Whisper — API</option>
              <option value="vosk">Vosk — self-hosted</option>
            </select>
          </Field>
          {asrProvider === "gigaam" && (
            <>
              <Field label="URL шлюза"><input placeholder="http://gigaam:8000" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
              <Field label="API-токен"><input type="password" placeholder="••••••••" style={inp()} /></Field>
            </>
          )}
          {asrProvider === "whisper" && (
            <Field label="OpenAI API ключ"><input type="password" placeholder="sk-…" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0 0", borderTop: `1px solid ${C.border}`, marginTop: 6 }}>
            <input id="ai-diar" type="checkbox" checked={diarization} onChange={(e) => setDiarization(e.target.checked)} />
            <label htmlFor="ai-diar" style={{ fontSize: 13, color: C.text, cursor: "pointer" }}>
              Диаризация спикеров
              <span style={{ display: "block", fontSize: 11.5, color: C.text3, marginTop: 2 }}>
                Разделение реплик по каналам (стерео-запись звонка) или по голосам.
              </span>
            </label>
          </div>
        </Sec>

        <Sec title="Языковая модель (LLM)" sub="Используется для саммари, тегов и AI-аналитики звонков">
          <Field label="Провайдер">
            <select value={llmProvider} onChange={(e) => setLlmProvider(e.target.value)} style={{ ...inp(), cursor: "pointer" }}>
              <option value="none">Не использовать</option>
              <option value="openai">OpenAI (GPT-4o)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="local">Локальная (Ollama / vLLM)</option>
            </select>
          </Field>
          {llmProvider !== "none" && llmProvider !== "local" && (
            <Field label="API ключ"><input type="password" placeholder="••••••••" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
          )}
          {llmProvider === "local" && (
            <>
              <Field label="URL модели"><input placeholder="http://ollama:11434" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
              <Field label="Имя модели"><input placeholder="llama3.1:8b" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
            </>
          )}
          {llmProvider === "none" && (
            <div style={{ fontSize: 12, color: C.text3, lineHeight: 1.5 }}>
              AI-функции (саммари, действия, теги) будут недоступны. Дислог и базовая статистика — по-прежнему работают.
            </div>
          )}
        </Sec>

        <Sec title="Аналитика по умолчанию" sub="Какие AI-блоки показывать в просмотре расшифровки">
          {[
            { id: "summary", label: "Краткое содержание разговора", on: true },
            { id: "actions", label: "Действия и решения (action items)", on: true },
            { id: "tags",    label: "Авто-теги: тема, продукт, тональность", on: true },
            { id: "score",   label: "Оценка качества разговора (CSAT-прокси)", on: false },
          ].map((x) => (
            <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
              <input id={`ai-${x.id}`} type="checkbox" defaultChecked={x.on} disabled={llmProvider === "none"} />
              <label htmlFor={`ai-${x.id}`} style={{ fontSize: 13, color: llmProvider === "none" ? C.text3 : C.text, cursor: llmProvider === "none" ? "default" : "pointer" }}>
                {x.label}
              </label>
            </div>
          ))}
        </Sec>
      </div>
    </div>
  );
}

function SmtpSettingsPage({ hideHeader }: { hideHeader?: boolean } = {}) {
  const q = useSmtpConfig();
  const upd = useUpdateSmtpConfig();
  type Form = {
    host: string; port: number; encryption: "ssl" | "starttls" | "none" | "";
    user: string; password: string;
    from_name: string; from_email: string;
  };
  const [form, setForm] = useState<Form>({
    host: "", port: 587, encryption: "starttls", user: "", password: "", from_name: "", from_email: "",
  });
  const [pwTouched, setPwTouched] = useState(false);
  useEffect(() => {
    if (q.data) setForm({
      host: q.data.host, port: q.data.port || 587,
      encryption: (q.data.encryption || "starttls"),
      user: q.data.user, password: "",
      from_name: q.data.from_name, from_email: q.data.from_email,
    });
  }, [q.data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    try {
      await upd.mutateAsync({
        host: form.host, port: Number(form.port) || 587,
        encryption: form.encryption || "starttls",
        user: form.user,
        password: pwTouched ? form.password : "", // пустая строка → backend сохранит старый
        from_name: form.from_name, from_email: form.from_email,
      });
      setPwTouched(false);
    } catch (e) {
      alert("Не удалось сохранить: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const saveBtn = (
    <button onClick={() => void save()} disabled={upd.isPending}
      style={{ display: "flex", alignItems: "center", gap: 7, background: upd.isPending ? C.bg3 : (upd.isSuccess ? C.acc : C.text), color: upd.isPending ? C.text3 : "white", padding: "9px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: upd.isPending ? "default" : "pointer", fontFamily: "inherit" }}>
      {upd.isPending ? <><RefreshCw size={15} className="lk-spin" />Сохраняем…</>
        : upd.isSuccess ? <><Check size={15} />Сохранено</>
        : <><Save size={15} />Сохранить</>}
    </button>
  );

  return (
    <div style={{ minHeight: "100%", background: C.bg2 }}>
      {!hideHeader && (
        <PgHdr title="Настройки SMTP" sub="Отправка приглашений на встречи и уведомлений" action={saveBtn} />
      )}
      <div style={{ padding: 24, maxWidth: 640 }}>
        {hideHeader && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>{saveBtn}</div>
        )}

        <div style={{ marginBottom: 16, padding: "10px 12px", background: C.warnBg, border: `1px solid ${C.warnBrd}`, borderRadius: 8, fontSize: 12, color: C.warnTx, lineHeight: 1.5 }}>
          Настройки сохраняются в БД. Автоматическая отправка писем (приглашения, GDPR-отчёты) появится позже — пока ни один сценарий её не использует.
        </div>

        <SettingsSection title="Сервер SMTP" sub="Параметры подключения к почтовому серверу">
          <Field label="Хост"><input value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <Lbl>Порт</Lbl>
              <select value={String(form.port)} onChange={(e) => set("port", Number(e.target.value))} style={{ ...inp(), fontFamily: "'DM Mono', monospace", cursor: "pointer" }}>
                <option value="25">25</option><option value="465">465</option><option value="587">587</option>
              </select>
            </div>
            <div>
              <Lbl>Шифрование</Lbl>
              <select value={form.encryption} onChange={(e) => set("encryption", e.target.value as Form["encryption"])} style={{ ...inp(), cursor: "pointer" }}>
                <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">Без шифрования</option>
              </select>
            </div>
          </div>
          <Field label="Логин"><input value={form.user} onChange={(e) => set("user", e.target.value)} placeholder="noreply@example.com" style={inp()} /></Field>
          <Field label={`Пароль${q.data?.has_password && !pwTouched ? " · сохранён" : ""}`}>
            <input type="password" value={form.password}
              onChange={(e) => { set("password", e.target.value); setPwTouched(true); }}
              placeholder={q.data?.has_password && !pwTouched ? "••••••••" : "Введите пароль"} style={inp()} />
          </Field>
        </SettingsSection>

        <SettingsSection title="Отправитель" sub="Как будет выглядеть адрес в письмах">
          <Field label="Имя отправителя"><input value={form.from_name} onChange={(e) => set("from_name", e.target.value)} placeholder="Название компании" style={inp()} /></Field>
          <Field label="Email отправителя"><input value={form.from_email} onChange={(e) => set("from_email", e.target.value)} placeholder="noreply@example.com" style={{ ...inp(), fontFamily: "'DM Mono', monospace" }} /></Field>
        </SettingsSection>

        <SettingsSection title="Проверка" sub="Тестовая отправка появится вместе с email-уведомлениями">
          <button disabled title="Функция тестовой отправки появится позже"
            style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg3, color: C.text3, fontSize: 13, fontWeight: 500, cursor: "default", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
            <Send size={14} />Отправить тест
          </button>
        </SettingsSection>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PROFILE MODAL
// ──────────────────────────────────────────────────────────────────────────

function ProfileModal({ onClose, me }: { onClose: () => void; me: MockUser }) {
  const { push, status } = useApp();
  const { logout } = useAuth();
  const [hasNum] = useState(!!me.ext);
  const [requested, setRequested] = useState(false);
  const [copied, setCopied] = useState(false);
  const curStatus = STATUSES[status];

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const uid = me.uid || `usr_${me.id}`;
  const copy = () => {
    void navigator.clipboard?.writeText(uid);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };

  const Row = ({ label, value, mono, action }: { label: string; value: ReactNode; mono?: boolean; action?: ReactNode }) => (
    <div style={{ display: "flex", alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ width: 170, fontSize: 12.5, color: C.text2, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13.5, color: C.text, fontWeight: 500, fontFamily: mono ? "'DM Mono', monospace" : "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      {action}
    </div>
  );

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", overflowY: "auto" }}>
      <div style={{ background: C.bg2, borderRadius: 12, width: "100%", maxWidth: 680, boxShadow: "0 20px 50px rgba(0,0,0,0.2)", display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 80px)", overflow: "hidden", border: `1px solid ${C.border}` }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.border}`, background: C.card, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: C.text }}>Мой профиль</h2>
            <p style={{ margin: "3px 0 0", fontSize: 12.5, color: C.text2 }}>Учётные данные и доступы сотрудника</p>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", color: C.text2, cursor: "pointer", border: "none" }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "20px 22px" }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 14, display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <Av i={me.av} c={me.col} sz={64} src={me.avatarUrl} />
              <span style={{ position: "absolute", bottom: 0, right: 0, width: 16, height: 16, borderRadius: "50%", background: curStatus.col, border: `3px solid ${C.card}`, boxSizing: "content-box" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600, color: C.text }}>{me.name}</h2>
              {me.position && (
                <div style={{ fontSize: 13, color: C.text2, marginBottom: 7, fontWeight: 500 }}>{me.position}</div>
              )}
              <div style={{ display: "flex", gap: 6, marginBottom: 7, flexWrap: "wrap", alignItems: "center" }}>
                <Bdg v="adm">{me.role === "admin" ? "Администратор" : "Пользователь"}</Bdg>
                <Bdg>{me.dept}</Bdg>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: C.text2 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: curStatus.col }} />
                  {curStatus.label}
                </span>
              </div>
              <div style={{ fontSize: 13, color: C.text2, display: "flex", alignItems: "center", gap: 6 }}>
                <Mail size={13} />{me.email}
              </div>
            </div>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 14, overflow: "hidden" }}>
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, fontSize: 13.5, fontWeight: 600, color: C.text }}>Учётная запись</div>
            <div style={{ padding: "2px 18px 12px" }}>
              <Row label="ID пользователя" value={uid} mono action={
                <button onClick={copy} style={{ width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: copied ? C.accBg2 : "transparent", color: copied ? C.acc : C.text3, cursor: "pointer", border: "none" }}>
                  {copied ? <Check size={14} /> : <Copy size={13} />}
                </button>
              } />
              {me.bitrixId && <Row label="Bitrix24 ID" value={me.bitrixId} mono />}
              <Row label="Email" value={me.email} />
              <Row label="Отдел" value={me.dept} />
              {me.position && <Row label="Должность" value={me.position} />}
              {me.phone && <Row label="Телефон" value={me.phone} mono />}
              <Row label="Последний вход" value={<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: C.acc, display: "inline-block" }} />Активен сейчас</span>} />
            </div>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 14, overflow: "hidden" }}>
            <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>Телефония</span>
              <span style={{ fontSize: 11, color: C.text3, display: "flex", alignItems: "center", gap: 5 }}>
                <Shield size={11} />Управляется администратором
              </span>
            </div>
            {hasNum && me.ext ? (
              <div style={{ padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 52, height: 52, borderRadius: 13, background: C.accBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Phone size={21} color={C.acc} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Внутренний номер</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 600, color: C.text, letterSpacing: "0.02em" }}>#{me.ext}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.acc, boxShadow: `0 0 0 2px ${C.acc}33` }} />
                      <span style={{ fontSize: 12, color: C.acc, fontWeight: 600 }}>Зарегистрирован на FreePBX</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: "18px" }}>
                <div style={{ background: C.warnBg, border: `1px solid ${C.warnBrd}`, borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: C.card, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <PhoneOff size={16} color={C.warnTx} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.warnTx }}>Внутренний номер не назначен</div>
                    <div style={{ fontSize: 12, color: C.warnTx, marginTop: 3, lineHeight: 1.5 }}>
                      Звонки через внутреннюю АТС недоступны. Отправьте запрос администратору — номер будет назначен из свободного пула.
                    </div>
                  </div>
                </div>
                {!requested ? (
                  <button onClick={() => {
                    setRequested(true);
                    push({ type: "request", title: "Запрос на номер отправлен", desc: "Администратор получит уведомление и назначит внутренний номер" });
                  }} style={{ background: C.acc, color: "white", padding: "10px 18px", borderRadius: 8, fontWeight: 600, fontSize: 14, border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7 }}>
                    <Phone size={15} />Запросить номер
                  </button>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: C.accBg, border: `1px solid ${C.accBrd}`, borderRadius: 8, color: C.accTx, fontSize: 13, fontWeight: 500 }}>
                    <Clock size={14} />
                    <span style={{ flex: 1 }}>Запрос отправлен администратору · ожидайте назначения</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ flex: 1, padding: "10px 16px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontWeight: 500, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <Key size={14} />Сменить пароль
            </button>
            <button onClick={() => { void logout(); }}
              style={{ padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.err, fontWeight: 500, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7 }}>
              <LogOut size={14} />Выйти
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// STUB pages (Мессенджеры / Контакты / Хелпдэск — пока не реализованы)
// ──────────────────────────────────────────────────────────────────────────

function StubPage({ page }: { page: "messengers" | "contacts" | "helpdesk" }) {
  const M = {
    messengers: { Icon: MessageSquare, col: C.ok,   bg: C.okBg,   title: "Мессенджеры", desc: "Омниканальный inbox: WhatsApp, Telegram и другие каналы. Также внутренний чат сотрудников.", stage: "В разработке" },
    contacts:   { Icon: Users,         col: C.purp, bg: C.purpBg, title: "Контакты",    desc: "Справочник коллег с оргструктурой и внешних контрагентов, синхронизация с Bitrix24.",        stage: "В разработке" },
    helpdesk:   { Icon: HelpCircle,    col: C.warn, bg: C.warnBg, title: "Хелпдэск",    desc: "Система тикетов для ИТ, АХО, HR. SLA-политики, назначение, история обращений, база знаний.", stage: "В разработке" },
  } as const;
  const m = M[page];
  return (
    <div style={{ minHeight: "100%", background: C.bg2, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 380, padding: 24 }}>
        <div style={{ width: 68, height: 68, borderRadius: 20, background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <m.Icon size={30} color={m.col} />
        </div>
        <h2 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 600, color: C.text }}>{m.title}</h2>
        <p style={{ margin: "0 0 20px", fontSize: 14, color: C.text2, lineHeight: 1.65 }}>{m.desc}</p>
        <Bdg v="warn">{m.stage}</Bdg>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// NAV CONFIG + APP
// ──────────────────────────────────────────────────────────────────────────

const NAV: NavItemDef[] = [
  { id: "vcs",           label: "Конференции",   Icon: Video },
  { id: "transcription", label: "Транскрибация", Icon: FileText },
  { id: "messengers",    label: "Мессенджеры",   Icon: MessageSquare, stub: true },
  { id: "contacts",      label: "Контакты",      Icon: Users,         stub: true },
  { id: "helpdesk",      label: "Хелпдэск",      Icon: HelpCircle,    stub: true },
];
// Админ-меню: только пользователям с role=admin. Мониторинг АТС переехал
// сюда из основного меню — он показывает оперативные метрики FreePBX и
// нужен только дежурному админу.
const ADM: NavItemDef[] = [
  { id: "monitoring", label: "Мониторинг АТС",    Icon: BarChart3 },
  { id: "settings",   label: "Настройки системы", Icon: Settings },
];

export function Shell({ me }: { me: Me }) {
  return (
    <AppProvider>
      <ShellInner me={me} />
    </AppProvider>
  );
}

function ShellInner({ me }: { me: Me }) {
  const [page, setPage] = useState<string>("vcs");
  // Когда переходим на transcription по «Открыть расшифровки» с конкретной
  // встречи — фильтруем список по meeting_id.
  const [transcriptMeetingFilter, setTranscriptMeetingFilter] = useState<string | undefined>();
  const goToTranscriptions = (meetingId?: string) => {
    setTranscriptMeetingFilter(meetingId);
    setPage("transcription");
  };
  const [profileOpen, setProfileOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { status } = useApp();
  const curStatus = STATUSES[status];

  const meAsMock = meAsMockUser(me);
  const isAdmin = me.role === "admin";

  // Module-access — админам показываем всё, остальным фильтруем по флагам.
  const moduleAccess = useModuleAccess().data;
  const visibleNav = isAdmin ? NAV : NAV.filter((it) => {
    if (!moduleAccess) return true;
    return (moduleAccess as unknown as Record<string, boolean>)[it.id] !== false;
  });
  // Если non-admin сейчас на скрытом модуле — переадресуем на первый доступный.
  const allowedPage = (isAdmin || visibleNav.some((it) => it.id === page))
    ? page
    : (visibleNav[0]?.id ?? "vcs");

  const onEnter = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setExpanded(true); };
  const onLeave = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setExpanded(false), 120); };

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", fontFamily: "'Outfit', system-ui, sans-serif", color: C.text, background: C.bg }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing:border-box; }
        button { cursor:pointer; border:none; background:none; font-family:inherit; }
        input, select, textarea { font-family:inherit; }
        input::placeholder, textarea::placeholder { color:${C.text3}; }
        ::-webkit-scrollbar { width:6px; height:6px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:${C.border2}; border-radius:3px; }
        ::-webkit-scrollbar-thumb:hover { background:${C.text3}; }
        @keyframes lk-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      `}</style>

      <nav onMouseEnter={onEnter} onMouseLeave={onLeave}
        style={{ width: expanded ? 220 : 56, background: C.bg2, display: "flex", flexDirection: "column", transition: "width 180ms ease", overflow: "hidden", flexShrink: 0, borderRight: `1px solid ${C.border}`, position: "relative", zIndex: 20 }}>
        <div style={{ padding: "12px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap", minHeight: 56 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: C.card, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden", padding: 3 }}>
            <img src={LOGO_URL} alt=""
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                const p = e.currentTarget.parentElement;
                if (p && !p.querySelector("span")) {
                  const s = document.createElement("span");
                  s.textContent = "TK";
                  s.style.cssText = `color:${C.acc};font-weight:700;font-size:13px`;
                  p.appendChild(s);
                }
              }}
            />
          </div>
          <div style={{ minWidth: 0, overflow: "hidden", opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms" }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em", lineHeight: 1.15 }}>Toolkit</div>
            <div style={{ color: C.text3, fontSize: 11, marginTop: 1 }}>Корпоративные коммуникации</div>
          </div>
        </div>

        <div style={{ flex: 1, padding: "8px 0", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px 4px", fontSize: 10, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: "0.09em", whiteSpace: "nowrap", opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms", height: expanded ? "auto" : 0, overflow: "hidden" }}>Инструменты</div>
          {visibleNav.map((item) => <NavItem key={item.id} item={item} active={page === item.id} expanded={expanded} onClick={() => setPage(item.id)} />)}
          {isAdmin && <>
            <div style={{ margin: "8px 12px", borderTop: `1px solid ${C.border}` }} />
            <div style={{ padding: "4px 14px 4px", fontSize: 10, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: "0.09em", whiteSpace: "nowrap", opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms", height: expanded ? "auto" : 0, overflow: "hidden" }}>Администратор</div>
            {ADM.map((item) => <NavItem key={item.id} item={item} active={page === item.id} expanded={expanded} onClick={() => setPage(item.id)} />)}
          </>}
        </div>

        <BottomActions expanded={expanded} />

        <button onClick={() => setProfileOpen(true)} title={!expanded ? "Мой профиль" : undefined}
          style={{ borderTop: `1px solid ${C.border}`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 11, background: profileOpen ? C.bg3 : "transparent", width: "100%", border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", overflow: "hidden" }}>
          <div style={{ position: "relative", flexShrink: 0 }}>
            <Av i={meAsMock.av} c={meAsMock.col} sz={32} src={meAsMock.avatarUrl} />
            <span style={{ position: "absolute", bottom: -1, right: -1, width: 10, height: 10, borderRadius: "50%", background: curStatus.col, border: `2px solid ${C.bg2}`, boxSizing: "content-box" }} />
          </div>
          <div style={{ flex: 1, overflow: "hidden", textAlign: "left", opacity: expanded ? 1 : 0, transition: "opacity 120ms", transitionDelay: expanded ? "80ms" : "0ms" }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meAsMock.name}</div>
            <div style={{ color: C.text3, fontSize: 11, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {meAsMock.ext ? `#${meAsMock.ext}` : meAsMock.email}
            </div>
          </div>
          {expanded && <ChevronRight size={14} color={C.text3} />}
        </button>
      </nav>

      <main style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {allowedPage === "vcs"             && <VcsPage me={me} onOpenTranscriptions={goToTranscriptions} />}
        {allowedPage === "transcription"   && <TranscriptionPage meetingFilter={transcriptMeetingFilter} />}
        {isAdmin && allowedPage === "monitoring" && <AnalyticsPage />}
        {isAdmin && allowedPage === "settings"   && <SystemSettingsPage />}
        {(["messengers", "contacts", "helpdesk"] as const).includes(allowedPage as any) && <StubPage page={allowedPage as "messengers" | "contacts" | "helpdesk"} />}
      </main>

      <SoftphoneWidget />

      {profileOpen && <ProfileModal me={meAsMock} onClose={() => setProfileOpen(false)} />}
    </div>
  );
}
