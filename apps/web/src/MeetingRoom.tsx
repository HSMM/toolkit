// MeetingRoom — LiveKit-комната, обёрнутая в дефолтный pre-built UI.
// Используется внутри VcsPage (Shell.tsx) после успешного /meetings/{id}/join.
//
// MVP: дефолтный VideoConference layout (видео-плитки + контролы + ChatToggle).
// Никаких кастомизаций, чтобы не отвлекаться от пайплайна. Кастомный layout
// (custom controls, sidebar with participants) — отдельная итерация E5.x.

import "@livekit/components-styles";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
} from "@livekit/components-react";
import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { C } from "@/styles/tokens";
import { useJoinMeeting, useEndMeeting, useLeaveMeeting, type Meeting } from "@/api/meetings";

type Props = {
  meeting: Meeting;
  isHost: boolean;
  onClose: () => void;
};

export function MeetingRoom({ meeting, isHost, onClose }: Props) {
  const join = useJoinMeeting();
  const leave = useLeaveMeeting();
  const end = useEndMeeting();
  const [creds, setCreds] = useState<{ token: string; wsURL: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // На монтирование запрашиваем токен.
  useEffect(() => {
    let cancelled = false;
    join.mutateAsync(meeting.id).then(
      (r) => { if (!cancelled) setCreds({ token: r.token, wsURL: r.ws_url }); },
      (e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Не удалось получить токен"); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  const close = () => {
    void leave.mutateAsync(meeting.id).catch(() => undefined);
    onClose();
  };
  const endForAll = async () => {
    if (!confirm("Завершить встречу для всех участников?")) return;
    await end.mutateAsync(meeting.id).catch(() => undefined);
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0b0b0c", zIndex: 300,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        flexShrink: 0, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12,
        borderBottom: "1px solid #1f1f22", background: "#111114", color: "#e5e7eb",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {meeting.title}
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'DM Mono', monospace" }}>
            {meeting.livekit_room_id}
          </div>
        </div>
        {isHost && (
          <button onClick={endForAll}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #ef4444", background: "transparent",
              color: "#ef4444", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            Завершить для всех
          </button>
        )}
        <button onClick={close} title="Покинуть"
          style={{ width: 36, height: 36, borderRadius: 8, background: "#1f1f22", color: "#e5e7eb",
            border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <X size={18} />
        </button>
      </div>

      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {!creds && !err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            color: "#9ca3af", gap: 10, fontSize: 14 }}>
            <Loader2 size={20} className="lk-spin" /> Подключение к комнате…
            <style>{`.lk-spin{animation:lk-spin 1s linear infinite}@keyframes lk-spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
        {err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            flexDirection: "column", gap: 14, color: "#fca5a5", fontSize: 14, textAlign: "center", padding: 24 }}>
            <div>Ошибка подключения: {err}</div>
            <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, background: C.acc, color: "white",
              border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>Закрыть</button>
          </div>
        )}
        {creds && (
          <LiveKitRoom
            token={creds.token}
            serverUrl={creds.wsURL}
            connect
            // video/audio НЕ выставляем здесь — иначе LK сразу делает
            // getUserMedia({audio:true, video:true}), и если в системе нет
            // камеры (или микрофона), весь захват падает с NotFoundError.
            // Пользователь включит микрофон/камеру сам через контролы внизу;
            // VideoConference UI сразу покажет правильное состояние "muted".
            data-lk-theme="default"
            style={{ height: "100%", width: "100%" }}
            onDisconnected={close}
          >
            <VideoConference />
            <RoomAudioRenderer />
          </LiveKitRoom>
        )}
      </div>
    </div>
  );
}
