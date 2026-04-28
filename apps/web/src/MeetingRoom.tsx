// MeetingRoom — LiveKit-комната, обёрнутая в дефолтный pre-built UI
// (VideoConference: видео-плитки + контролы + ChatToggle).
// Используется внутри VcsPage (Shell.tsx) после успешного /meetings/{id}/join.

import "@livekit/components-styles";
import { LiveKitRoom } from "@livekit/components-react";
import { RussianRoomUI } from "@/RoomUI";
import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Check, UserPlus, Circle, Square } from "lucide-react";
import { C } from "@/styles/tokens";
import {
  useJoinMeeting, useEndMeeting, useLeaveMeeting, useMeetingPoll, useAdmitGuest,
  useStartRecording, useStopRecording,
  type Meeting, type Participant,
} from "@/api/meetings";
import { loadPrefs } from "@/meetSettings/prefs";

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

  // Пользовательские preferences из шестерёнки на VcsPage. Снимок один раз
  // на монтирование комнаты; смена prefs во время разговора не требует
  // переподключения (для применения нужно перезайти).
  const prefs = useMemo(() => loadPrefs(), []);

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
        {isHost && <RecordingButton meetingId={meeting.id} />}
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
            // audio/video автоматически публикуются только если пользователь
            // явно опт-ин'ил в Настройках (joinMuted=false / joinVideoOff=false).
            // Если в системе нет устройства, LK эмитит onMediaDeviceFailure
            // и продолжает подключение к комнате; пользователь включит
            // нужное устройство через контролы внизу.
            audio={!prefs.joinMuted}
            video={!prefs.joinVideoOff}
            options={{
              audioCaptureDefaults: {
                deviceId: prefs.audioDeviceId || undefined,
                noiseSuppression: prefs.noiseSuppression,
                echoCancellation: true,
                autoGainControl: true,
              },
              videoCaptureDefaults: {
                deviceId: prefs.videoDeviceId || undefined,
              },
              audioOutput: prefs.speakerDeviceId
                ? { deviceId: prefs.speakerDeviceId }
                : undefined,
            }}
            onMediaDeviceFailure={(failure) => {
              // Не валим всё подключение — LK уже игнорирует упавший трек
              // и пускает в комнату без него. Только логируем.
              console.warn("[MeetingRoom] media device failure:", failure);
            }}
            data-lk-theme="default"
            style={{ height: "100%", width: "100%" }}
            onDisconnected={close}
          >
            <RussianRoomUI />
          </LiveKitRoom>
        )}

        {/* Хост видит панель ожидающих гостей. Поллится каждые 3с. */}
        {isHost && <PendingGuestsPanel meetingId={meeting.id} />}
      </div>
    </div>
  );
}

// RecordingButton — для host: «● Начать запись» / «■ Остановить запись».
// Состояние active берётся из useMeetingPoll — это тот же query, что и
// PendingGuestsPanel, так что лишних запросов нет.
function RecordingButton({ meetingId }: { meetingId: string }) {
  const q = useMeetingPoll(meetingId, 3000);
  const start = useStartRecording();
  const stop = useStopRecording();
  const active = q.data?.meeting?.recording_active === true;
  const busy = start.isPending || stop.isPending;

  return (
    <button
      onClick={() => active ? stop.mutate(meetingId) : start.mutate(meetingId)}
      disabled={busy}
      title={active ? "Остановить запись встречи" : "Начать запись встречи"}
      style={{
        padding: "7px 14px", borderRadius: 8, border: "none",
        background: active ? "rgba(239, 68, 68, 0.15)" : "rgba(255,255,255,0.08)",
        color: active ? "#fca5a5" : "#e5e7eb",
        fontWeight: 600, fontSize: 13, cursor: busy ? "default" : "pointer",
        fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7,
        opacity: busy ? 0.6 : 1,
      }}>
      {active
        ? <><Square size={14} fill="#ef4444" stroke="#ef4444" />Остановить запись</>
        : <><Circle size={14} fill="#ef4444" stroke="#ef4444" />Начать запись</>}
    </button>
  );
}

function PendingGuestsPanel({ meetingId }: { meetingId: string }) {
  const q = useMeetingPoll(meetingId, 3000);
  const admit = useAdmitGuest();
  const pending: Participant[] = (q.data?.participants ?? []).filter((p) => p.admit_state === "pending");
  if (pending.length === 0) return null;

  return (
    <div style={{
      position: "absolute", top: 16, right: 16, width: 320, maxHeight: "70vh", overflowY: "auto",
      background: "#1a1a1d", border: "1px solid #2a2a2e", borderRadius: 12,
      boxShadow: "0 12px 30px rgba(0,0,0,0.45)", color: "#e5e7eb", zIndex: 5,
    }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #2a2a2e", display: "flex", alignItems: "center", gap: 8 }}>
        <UserPlus size={16} color={C.acc} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Ожидают входа</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af", padding: "2px 7px", borderRadius: 999, background: "#2a2a2e" }}>{pending.length}</span>
      </div>
      <div style={{ padding: 8 }}>
        {pending.map((p) => {
          const name = p.external_name || p.display_name || "Гость";
          const busy = admit.isPending && admit.variables?.participantId === p.id;
          return (
            <div key={p.id} style={{ padding: "10px 10px", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.acc, color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                {(name[0] || "?").toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>гость · ждёт сейчас</div>
              </div>
              <button onClick={() => admit.mutate({ meetingId, participantId: p.id, allow: true })} disabled={busy}
                title="Допустить"
                style={{ width: 30, height: 30, borderRadius: 6, border: "none", background: C.acc, color: "white", cursor: busy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
                <Check size={15} />
              </button>
              <button onClick={() => admit.mutate({ meetingId, participantId: p.id, allow: false })} disabled={busy}
                title="Отклонить"
                style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #ef4444", background: "transparent", color: "#ef4444", cursor: busy ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
