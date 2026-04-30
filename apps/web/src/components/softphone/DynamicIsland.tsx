import { Loader2, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import type { CallState, RegistrationStatus } from "./types";
import { formatClock, initials } from "./utils";

type Props = {
  registration: RegistrationStatus;
  call: CallState;
  elapsedMs: number;
  onOpenCall: () => void;
  onAnswer: () => void;
  onReject: () => void;
};

export function DynamicIsland({ registration, call, elapsedMs, onOpenCall, onAnswer, onReject }: Props) {
  const kind = call.kind === "incoming" || call.kind === "dialing" || call.kind === "active" || call.kind === "ended"
    ? call.kind
    : registration === "connecting"
      ? "connecting"
      : "idle";

  if (call.kind === "incoming") {
    return (
      <button className="sp-island incoming" onClick={onOpenCall} aria-label="Открыть входящий вызов">
        <span className="sp-avatar" style={{ width: 46, height: 46 }}>
          {call.from.avatar ? <img src={call.from.avatar} alt="" /> : initials(call.from.name)}
        </span>
        <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {call.from.name ?? call.from.number}
          </span>
          <span style={{ display: "block", marginTop: 3, fontSize: 11, color: "rgba(255,255,255,.68)" }}>{call.from.number}</span>
        </span>
        <span className="sp-icon-row">
          <span
            role="button"
            tabIndex={0}
            className="sp-round-btn danger"
            style={{ width: 40, height: 40 }}
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onReject(); }
            }}
            aria-label="Отклонить"
          >
            <PhoneOff size={18} />
          </span>
          <span
            role="button"
            tabIndex={0}
            className="sp-round-btn primary"
            style={{ width: 40, height: 40 }}
            onClick={(e) => { e.stopPropagation(); onAnswer(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onAnswer(); }
            }}
            aria-label="Принять"
          >
            <Phone size={18} />
          </span>
        </span>
      </button>
    );
  }

  return (
    <button className={`sp-island ${kind}`} onClick={call.kind === "active" ? onOpenCall : undefined} aria-label="Dynamic Island">
      {registration === "connecting" && call.kind === "idle" && (
        <>
          <Loader2 size={14} style={{ animation: "sp-pulse 1s infinite" }} />
          <span style={{ fontSize: 10, color: "rgba(255,255,255,.78)" }}>Подключение</span>
        </>
      )}
      {registration === "online" && call.kind === "idle" && <span style={{ width: 8, height: 8, borderRadius: 999, background: "#10b981" }} />}
      {call.kind === "dialing" && (
        <>
          <Phone size={14} style={{ color: "#10b981", animation: "sp-pulse 1s infinite" }} />
          <span style={{ minWidth: 0, display: "grid", textAlign: "left" }}>
            <span style={{ fontSize: 10, fontWeight: 800 }}>{call.phase === "ringing" ? "Вызов..." : "Соединение..."}</span>
            <span style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {call.to.number}{call.earlyMedia ? " · АТС" : ""}
            </span>
          </span>
        </>
      )}
      {call.kind === "active" && (
        <>
          <Phone size={14} style={{ color: "#10b981" }} />
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, fontWeight: 800 }}>{formatClock(elapsedMs)}</span>
          {call.muted ? <MicOff size={14} /> : <Mic size={14} />}
        </>
      )}
      {call.kind === "ended" && <span style={{ fontSize: 12, fontWeight: 800 }}>Вызов завершён</span>}
    </button>
  );
}
