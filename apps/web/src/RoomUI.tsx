// RussianRoomUI — кастомная сборка UI комнаты LiveKit с русскими лейблами.
//
// Layout:
//   • верхняя зона: видео-плитки участников (Grid или Speaker view)
//   • правая боковая панель: Чат / Список участников (одна за раз)
//   • нижняя панель: контролы микрофона/камеры/демо/чата + ⋮ меню + завершить
//   • ⋮ меню: запись на компьютер, переключение Speaker/Grid, права, настройки
//
// Расширения (фича-флаги):
//   • hand-raise: через LiveKit DataChannel topic="toolkit:hand-raise"
//   • permissions: через DataChannel topic="toolkit:perms" (только хост шлёт)
//   • local recording: getDisplayMedia + MediaRecorder → загрузка .webm

import "@livekit/components-styles";
import {
  GridLayout, ParticipantTile, useTracks, useTrackToggle,
  RoomAudioRenderer, useChat, useParticipants, useLocalParticipant,
  FocusLayoutContainer, FocusLayout, CarouselLayout, useDataChannel,
  useDisconnectButton,
} from "@livekit/components-react";
import { Track, RoomEvent, LocalVideoTrack } from "livekit-client";
import { BackgroundBlur, VirtualBackground } from "@livekit/track-processors";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Mic, MicOff, Video, VideoOff, Monitor, MessageSquare, PhoneOff, Send,
  Hand, Users, MoreVertical, Circle, LayoutGrid,
  Settings as SettingsIcon, Link2, Check, Square,
} from "lucide-react";
import { MeetingSettingsModal } from "@/meetSettings/MeetingSettingsModal";
import { usePrefs, gradientToDataURL, type MeetBackground } from "@/meetSettings/prefs";

type Props = {
  /** Дополнительные кнопки в верхней панели — пробрасываем извне (host: кнопка серверной записи). */
  topRight?: React.ReactNode;
  /** Гостевая ссылка — для кнопки «Скопировать» в нижнем-левом углу (только хост). */
  guestUrl?: string;
};

type SidePanel = "none" | "chat" | "participants";
type LayoutMode = "grid" | "speaker";

// Типы payload'ов на DataChannel.
type HandRaiseMsg = { kind: "raise" | "lower" };

const HAND_RAISE_TOPIC = "toolkit:hand-raise";

export function RussianRoomUI({ topRight, guestUrl }: Props = {}) {
  // ─── Tracks ────────────────────────────────────────────────────────────
  const tracks = useTracks(
    [
      { source: Track.Source.Camera,      withPlaceholder: true  },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged] },
  );
  const screenShare = tracks.find((t) => t.source === Track.Source.ScreenShare);

  // ─── UI state ──────────────────────────────────────────────────────────
  const [sidePanel, setSidePanel] = useState<SidePanel>("none");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid");
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"sound" | "video" | "background">("sound");

  // ─── Background effect (виртуальный фон) ──────────────────────────────
  const [prefs] = usePrefs();
  useBackgroundEffect(prefs.background);

  // ─── Hand raise ────────────────────────────────────────────────────────
  const { localParticipant } = useLocalParticipant();
  const [myHandUp, setMyHandUp] = useState(false);
  const [handsUp, setHandsUp] = useState<Set<string>>(new Set()); // identity участников с поднятой рукой
  const [toast, setToast] = useState<string | null>(null);
  const { send: sendHand } = useDataChannel(HAND_RAISE_TOPIC, (msg) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as HandRaiseMsg;
      const fromIdent = msg.from?.identity;
      if (!fromIdent) return;
      setHandsUp((cur) => {
        const next = new Set(cur);
        if (parsed.kind === "raise") next.add(fromIdent); else next.delete(fromIdent);
        return next;
      });
      if (parsed.kind === "raise") {
        const name = msg.from?.name || msg.from?.identity || "Участник";
        setToast(`✋ ${name} поднял руку`);
        setTimeout(() => setToast(null), 3500);
      }
    } catch { /* noop */ }
  });
  const toggleHand = () => {
    const next = !myHandUp;
    setMyHandUp(next);
    const myId = localParticipant?.identity;
    if (myId) {
      setHandsUp((cur) => {
        const s = new Set(cur);
        if (next) s.add(myId); else s.delete(myId);
        return s;
      });
    }
    const buf = new TextEncoder().encode(JSON.stringify({ kind: next ? "raise" : "lower" } as HandRaiseMsg));
    void sendHand(buf, { topic: HAND_RAISE_TOPIC, reliable: true });
  };

  // ─── Local recording ───────────────────────────────────────────────────
  const recRef = useRef<{ rec: MediaRecorder; chunks: BlobPart[]; stream: MediaStream } | null>(null);
  const [recording, setRecording] = useState(false);
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus" : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mime });
        triggerDownload(blob, defaultFilename());
        recRef.current = null;
        setRecording(false);
      };
      // Если пользователь сам остановит шеринг (через UI браузера) — корректно завершим.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recRef.current && recRef.current.rec.state !== "inactive") {
          recRef.current.rec.stop();
        }
      });
      rec.start(1000);
      recRef.current = { rec, chunks, stream };
      setRecording(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // NotAllowedError — пользователь отклонил выбор экрана; молча.
      if (!/NotAllowedError|aborted/i.test(msg)) {
        alert("Не удалось начать запись: " + msg);
      }
    }
  };
  const stopRecording = () => {
    const r = recRef.current;
    if (r && r.rec.state !== "inactive") r.rec.stop();
  };
  const toggleRecording = () => { if (recording) stopRecording(); else void startRecording(); };

  // Закрываем меню по клику вне.
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  // ─── Layout switching ──────────────────────────────────────────────────
  // Если идёт screen share — автоматически в speaker view, чтобы не зажимать экран.
  const effectiveLayout: LayoutMode = screenShare ? "speaker" : layoutMode;
  const focusTrack = screenShare ?? tracks[0];
  const otherTracks = tracks.filter((t) => t !== focusTrack);

  // ─── Open settings on a specific tab ───────────────────────────────────
  const openSettings = (tab: "sound" | "video" | "background") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setMoreOpen(false);
  };

  const participants = useParticipants();
  const handsCount = handsUp.size;

  // ─── Guest link copy ───────────────────────────────────────────────────
  const [linkCopied, setLinkCopied] = useState(false);
  const copyLink = async () => {
    if (!guestUrl) return;
    try {
      await navigator.clipboard.writeText(guestUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* noop */ }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0b0b0c", position: "relative" }}>
      {topRight && (
        <div style={{ position: "absolute", top: 12, right: 16, zIndex: 5, display: "flex", gap: 8 }}>
          {topRight}
        </div>
      )}

      {/* Toast уведомлений (поднятая рука и т.д.) */}
      {toast && (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 8,
          background: "rgba(0,0,0,0.78)", color: "white", padding: "8px 16px",
          borderRadius: 999, fontSize: 13, fontWeight: 500,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}>{toast}</div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {effectiveLayout === "speaker" && focusTrack ? (
            <FocusLayoutContainer style={{ height: "100%" }}>
              <CarouselLayout tracks={otherTracks}>
                <ParticipantTile />
              </CarouselLayout>
              <FocusLayout trackRef={focusTrack} />
            </FocusLayoutContainer>
          ) : (
            <GridLayout tracks={tracks} style={{ height: "100%" }}>
              <ParticipantTile />
            </GridLayout>
          )}
        </div>

        {sidePanel === "chat" && <ChatPanel onClose={() => setSidePanel("none")} />}
        {sidePanel === "participants" && (
          <ParticipantsPanel
            participants={participants}
            handsUp={handsUp}
            myIdentity={localParticipant?.identity || ""}
            onClose={() => setSidePanel("none")} />
        )}
      </div>

      <RoomAudioRenderer />

      {/* Bottom toolbar */}
      <div style={{
        flexShrink: 0, display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center",
        gap: 10, padding: "12px 16px", background: "#111114", borderTop: "1px solid #1f1f22",
      }}>
        {/* Left cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {guestUrl && (
            <IconBtn title={linkCopied ? "Скопировано" : "Скопировать гостевую ссылку"}
              active={linkCopied} onClick={copyLink}>
              {linkCopied ? <Check size={18} /> : <Link2 size={18} />}
            </IconBtn>
          )}
          <ToggleIconBtn src={Track.Source.Microphone} OnI={Mic} OffI={MicOff}
            tooltip={(on) => on ? "Выключить микрофон" : "Включить микрофон"} />
          <ToggleIconBtn src={Track.Source.Camera} OnI={Video} OffI={VideoOff}
            tooltip={(on) => on ? "Выключить камеру" : "Включить камеру"} />
        </div>

        {/* Center cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CenterBtn label="" Icon={Hand} active={myHandUp} onClick={toggleHand}
            tooltip={myHandUp ? "Опустить руку" : "Поднять руку"} />
          <ScreenShareCenterBtn />
          <CenterBtn label="Участники" Icon={Users} badge={participants.length}
            active={sidePanel === "participants"}
            onClick={() => setSidePanel((s) => s === "participants" ? "none" : "participants")} />
          <CenterBtn label="Чат" Icon={MessageSquare}
            active={sidePanel === "chat"}
            onClick={() => setSidePanel((s) => s === "chat" ? "none" : "chat")} />

          {/* More menu — anchor */}
          <div ref={moreRef} style={{ position: "relative" }}>
            <CenterBtn label="" Icon={MoreVertical} active={moreOpen}
              onClick={() => setMoreOpen((v) => !v)} tooltip="Дополнительно" />
            {moreOpen && (
              <MoreMenu
                recording={recording}
                speakerView={layoutMode === "speaker"}
                onToggleRecord={() => { toggleRecording(); setMoreOpen(false); }}
                onToggleSpeakerView={() => {
                  setLayoutMode((m) => m === "speaker" ? "grid" : "speaker");
                  setMoreOpen(false);
                }}
                onOpenSettings={() => openSettings("sound")}
              />
            )}
          </div>
        </div>

        {/* Right cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          {handsCount > 0 && (
            <div style={{ fontSize: 12, color: "#facc15", display: "flex", alignItems: "center", gap: 6 }}>
              <Hand size={14} /> {handsCount}
            </div>
          )}
          <LeaveButton />
        </div>
      </div>

      {settingsOpen && (
        <MeetingSettingsModal
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Toolbar buttons
// ──────────────────────────────────────────────────────────────────────────

function ToggleIconBtn({
  src, OnI, OffI, tooltip,
}: {
  src: Track.Source.Microphone | Track.Source.Camera;
  OnI: typeof Mic; OffI: typeof Mic;
  tooltip: (on: boolean) => string;
}) {
  const { enabled, pending, toggle } = useTrackToggle({ source: src });
  const Icon = enabled ? OnI : OffI;
  return (
    <button onClick={() => void toggle()} disabled={pending} title={tooltip(enabled)}
      style={iconBtnStyle(!enabled, pending)}>
      <Icon size={18} />
    </button>
  );
}

function ScreenShareCenterBtn() {
  const { enabled, pending, toggle } = useTrackToggle({ source: Track.Source.ScreenShare });
  return (
    <button onClick={() => void toggle()} disabled={pending}
      title={enabled ? "Остановить демонстрацию" : "Начать демонстрацию экрана"}
      style={{ ...centerBtnStyle(enabled), opacity: pending ? 0.6 : 1 }}>
      <Monitor size={16} />
      <span>Демонстрация</span>
    </button>
  );
}

function CenterBtn({ label, Icon, active, onClick, tooltip, badge }: {
  label: string; Icon: typeof Mic; active: boolean; onClick: () => void;
  tooltip?: string; badge?: number;
}) {
  return (
    <button onClick={onClick} title={tooltip}
      style={centerBtnStyle(active)}>
      <Icon size={16} />
      {label && <span>{label}</span>}
      {badge !== undefined && badge > 0 && (
        <span style={{
          minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9,
          background: "rgba(255,255,255,0.15)", color: "white",
          fontSize: 11, fontWeight: 700,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>{badge}</span>
      )}
    </button>
  );
}

function IconBtn({ children, active, onClick, title }: {
  children: React.ReactNode; active?: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button onClick={onClick} title={title} style={iconBtnStyle(false, false, active)}>
      {children}
    </button>
  );
}

function LeaveButton() {
  const { buttonProps } = useDisconnectButton({ stopTracks: true });
  return (
    <button {...buttonProps} title="Покинуть"
      style={{
        width: 44, height: 44, borderRadius: "50%", border: "none",
        background: "#ef4444", color: "white", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
      <PhoneOff size={20} />
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// More menu
// ──────────────────────────────────────────────────────────────────────────

function MoreMenu({
  recording, speakerView,
  onToggleRecord, onToggleSpeakerView, onOpenSettings,
}: {
  recording: boolean; speakerView: boolean;
  onToggleRecord: () => void;
  onToggleSpeakerView: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div style={{
      position: "absolute", bottom: "calc(100% + 8px)", right: 0, width: 280,
      background: "#1c1c1f", border: "1px solid #2a2a2e", borderRadius: 12,
      boxShadow: "0 16px 40px rgba(0,0,0,0.45)", padding: 6, zIndex: 20,
    }}>
      <MenuItem
        icon={recording
          ? <Square size={16} fill="#ef4444" stroke="#ef4444" />
          : <Circle size={16} stroke="#ef4444" />}
        label={recording ? "Остановить запись" : "Записать на компьютер"}
        onClick={onToggleRecord}
        dot={recording} />
      <MenuDivider />
      <MenuItem icon={<LayoutGrid size={16} />}
        label={speakerView ? "Сетка участников" : "Вид докладчика"}
        onClick={onToggleSpeakerView} />
      <MenuItem icon={<SettingsIcon size={16} />} label="Настройки" onClick={onOpenSettings} />
    </div>
  );
}

function MenuItem({ icon, label, onClick, dot }: {
  icon: React.ReactNode; label: string; onClick: () => void; dot?: boolean;
}) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        width: "100%", textAlign: "left", background: "transparent", border: "none",
        borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
        color: "#e5e7eb", fontSize: 13.5, fontWeight: 500,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <span style={{ width: 18, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {dot && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }} />}
    </button>
  );
}

function MenuDivider() {
  return <div style={{ height: 1, background: "#2a2a2e", margin: "4px 8px" }} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Side panels
// ──────────────────────────────────────────────────────────────────────────

function ChatPanel({ onClose }: { onClose: () => void }) {
  const { send, chatMessages } = useChat();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chatMessages]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    try { await send(text); setDraft(""); }
    catch { /* noop */ }
  };

  return (
    <SidePanelShell title="Чат" onClose={onClose}>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {chatMessages.length === 0 && (
          <div style={{ color: "#6b7280", fontSize: 12, textAlign: "center", marginTop: 24 }}>
            Сообщений нет. Будьте первым!
          </div>
        )}
        {chatMessages.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 11, color: "#9ca3af" }}>
              {m.from?.name || m.from?.identity || "Гость"} · {fmtTime(m.timestamp)}
            </div>
            <div style={{ fontSize: 13, color: "#e5e7eb", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {m.message}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 10, borderTop: "1px solid #1f1f22", display: "flex", gap: 6 }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          placeholder="Сообщение…" rows={1}
          style={{
            flex: 1, resize: "none", padding: "8px 10px", borderRadius: 8,
            border: "1px solid #2a2a2e", background: "#0b0b0c", color: "#e5e7eb",
            fontSize: 13, fontFamily: "inherit", outline: "none",
          }} />
        <button onClick={() => void submit()} disabled={!draft.trim()} title="Отправить"
          style={{
            flexShrink: 0, width: 40, padding: 0, border: "none", borderRadius: 8,
            background: draft.trim() ? "#1E5AA8" : "#2a2a2e",
            color: draft.trim() ? "white" : "#6b7280",
            cursor: draft.trim() ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          <Send size={15} />
        </button>
      </div>
    </SidePanelShell>
  );
}

function ParticipantsPanel({
  participants, handsUp, myIdentity, onClose,
}: {
  participants: ReturnType<typeof useParticipants>;
  handsUp: Set<string>;
  myIdentity: string;
  onClose: () => void;
}) {
  return (
    <SidePanelShell title={`Участники · ${participants.length}`} onClose={onClose}>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px" }}>
        {participants.map((p) => {
          const name = p.name || p.identity;
          const isMe = p.identity === myIdentity;
          const handUp = handsUp.has(p.identity);
          const initials = (name || "?").trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
          const micEnabled = p.isMicrophoneEnabled;
          return (
            <div key={p.identity} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%", background: "#2a2a2e",
                color: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 600, flexShrink: 0,
              }}>{initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#e5e7eb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {name}{isMe && <span style={{ color: "#9ca3af", fontWeight: 400 }}> · вы</span>}
                </div>
              </div>
              {handUp && <Hand size={14} color="#facc15" />}
              {micEnabled
                ? <Mic size={14} color="#9ca3af" />
                : <MicOff size={14} color="#9ca3af" />}
            </div>
          );
        })}
      </div>
    </SidePanelShell>
  );
}

function SidePanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      width: 320, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "#15151a", borderLeft: "1px solid #1f1f22", color: "#e5e7eb",
    }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #1f1f22", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <button onClick={onClose} title="Закрыть"
          style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", padding: 4 }}>
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function iconBtnStyle(off: boolean, pending: boolean, active?: boolean): CSSProperties {
  return {
    width: 44, height: 44, borderRadius: "50%", border: "none",
    background: active ? "#1E5AA8" : off ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.08)",
    color: active ? "white" : off ? "#fca5a5" : "#e5e7eb",
    cursor: pending ? "default" : "pointer", opacity: pending ? 0.6 : 1,
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}

function centerBtnStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "9px 14px", borderRadius: 10,
    background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)",
    color: "#e5e7eb",
    border: "1px solid transparent",
    fontSize: 13, fontWeight: 500, fontFamily: "inherit", cursor: "pointer",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Virtual background effect
// ──────────────────────────────────────────────────────────────────────────

/**
 * Применяет к локальной видео-дорожке processor из @livekit/track-processors:
 * blur — BackgroundBlur, image — VirtualBackground (картинка / data-URL).
 *
 * Эффект автоматически реагирует на смену prefs.background и на смену
 * камеры (videoTrack меняется, useEffect перезапускается).
 */
function useBackgroundEffect(background: MeetBackground) {
  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  // Локальная дорожка — та, у которой participant.isLocal.
  const localTrackRef = cameraTracks.find((t) => t.participant.isLocal);
  const localTrack = localTrackRef?.publication?.track;

  // Сериализуем background для зависимостей useEffect.
  const bgKey = background.kind === "image"
    ? `image:${background.src}`
    : background.kind;

  useEffect(() => {
    if (!(localTrack instanceof LocalVideoTrack)) return;
    let cancelled = false;

    (async () => {
      try {
        if (background.kind === "none") {
          if (localTrack.getProcessor()) {
            await localTrack.stopProcessor();
          }
          return;
        }
        if (background.kind === "blur") {
          const processor = BackgroundBlur(10);
          if (cancelled) return;
          await localTrack.setProcessor(processor);
          return;
        }
        // image
        const url = resolveBgImageUrl(background.src);
        if (!url) return;
        const processor = VirtualBackground(url);
        if (cancelled) return;
        await localTrack.setProcessor(processor);
      } catch (e) {
        console.warn("[bg-effect] applying processor failed:", e);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgKey, localTrack]);
}

function resolveBgImageUrl(src: string): string {
  // Лениво импортировать helper из prefs нельзя в hook — поэтому inline.
  if (!src) return "";
  if (src.startsWith("data:")) return src;
  if (src.startsWith("gradient:")) return gradientToDataURL(src);
  return src;
}

function defaultFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `toolkit-meet-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.webm`;
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

