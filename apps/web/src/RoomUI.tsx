// RussianRoomUI — кастомная сборка UI комнаты LiveKit с русскими лейблами.
// Заменяет prefab <VideoConference /> (там строки на английском вшиты).
//
// Состав:
//   • видео-плитки участников (GridLayout + ParticipantTile)
//   • нижняя панель: Микрофон / Камера / Демонстрация / Чат / Покинуть
//   • боковая панель чата с собственным textarea и списком сообщений
//   • RoomAudioRenderer

import "@livekit/components-styles";
import {
  GridLayout, ParticipantTile, useTracks, useTrackToggle,
  DisconnectButton, RoomAudioRenderer, useChat,
} from "@livekit/components-react";
import { Track, RoomEvent } from "livekit-client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Mic, MicOff, Video, VideoOff, Monitor, MessageSquare, PhoneOff, Send,
} from "lucide-react";

type Props = {
  // Дополнительные кнопки в верхней или нижней панели — пробрасываем извне
  // (например «● Начать запись» для host'а).
  topRight?: React.ReactNode;
};

export function RussianRoomUI({ topRight }: Props = {}) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera,      withPlaceholder: true  },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged] },
  );
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0b0b0c" }}>
      {topRight && (
        <div style={{ position: "absolute", top: 12, right: 16, zIndex: 5, display: "flex", gap: 8 }}>
          {topRight}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <GridLayout tracks={tracks} style={{ height: "100%" }}>
            <ParticipantTile />
          </GridLayout>
        </div>

        {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
      </div>

      <RoomAudioRenderer />

      <div style={{
        flexShrink: 0, display: "flex", justifyContent: "center", alignItems: "center",
        gap: 10, padding: "12px 16px", background: "#111114", borderTop: "1px solid #1f1f22",
      }}>
        <RoomButton source="microphone" />
        <RoomButton source="camera" />
        <RoomButton source="screen-share" />
        <ChatButton open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
        <LeaveButton />
      </div>
    </div>
  );
}

// ────────────── Кнопки ──────────────

function RoomButton({ source }: { source: "microphone" | "camera" | "screen-share" }) {
  if (source === "microphone") return <ToggleBtn src={Track.Source.Microphone} label="Микрофон" OnI={Mic} OffI={MicOff} />;
  if (source === "camera")     return <ToggleBtn src={Track.Source.Camera}     label="Камера" OnI={Video} OffI={VideoOff} />;
  return <ToggleBtn src={Track.Source.ScreenShare} label="Демонстрация" OnI={Monitor} OffI={Monitor} />;
}

function ToggleBtn<T extends Track.Source.Microphone | Track.Source.Camera | Track.Source.ScreenShare>(
  { src, label, OnI, OffI }: { src: T; label: string; OnI: typeof Mic; OffI: typeof Mic },
) {
  const { enabled, pending, toggle } = useTrackToggle({ source: src });
  const Icon = enabled ? OnI : OffI;
  return (
    <button onClick={() => void toggle()} disabled={pending}
      style={{ ...btnStyle(enabled), opacity: pending ? 0.6 : 1 }}>
      <Icon size={16} /><span>{label}</span>
    </button>
  );
}

// ChatToggle мы НЕ используем — нужна синхронизация state с боковой панелью.
function ChatButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={btnStyle(open)}>
      <MessageSquare size={16} /><span>Чат</span>
    </button>
  );
}

function LeaveButton() {
  return (
    <DisconnectButton stopTracks className="lk-leave-russian"
      style={{
        ...btnStyle(false),
        background: "#ef4444", color: "white", borderColor: "#ef4444",
      }}>
      <PhoneOff size={16} /><span>Покинуть</span>
    </DisconnectButton>
  );
}

// ────────────── Чат ──────────────

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
    catch { /* мерцания UI здесь не нужны */ }
  };

  return (
    <div style={{
      width: 320, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "#15151a", borderLeft: "1px solid #1f1f22", color: "#e5e7eb",
    }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #1f1f22", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Чат</div>
        <button onClick={onClose} title="Закрыть"
          style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", padding: 4 }}>
          ✕
        </button>
      </div>
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
    </div>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function btnStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "9px 14px", borderRadius: 8,
    background: active ? "#1E5AA8" : "rgba(255,255,255,0.08)",
    color: active ? "white" : "#e5e7eb",
    border: `1px solid ${active ? "#1E5AA8" : "transparent"}`,
    fontSize: 13, fontWeight: 500, fontFamily: "inherit", cursor: "pointer",
  };
}
