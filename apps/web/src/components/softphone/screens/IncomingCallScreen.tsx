import { Phone, PhoneOff } from "lucide-react";
import type { CallState } from "../types";
import { initials } from "../utils";

export function IncomingCallScreen({ call, onAnswer, onReject }: { call: Extract<CallState, { kind: "incoming" }>; onAnswer: () => void; onReject: () => void }) {
  return (
    <section className="sp-overlay" aria-label="Входящий вызов">
      <div className="sp-overlay-title">Входящий вызов</div>
      <span className="sp-avatar large">{call.from.avatar ? <img src={call.from.avatar} alt="" /> : initials(call.from.name)}</span>
      <div className="sp-peer-name">{call.from.name ?? call.from.number}</div>
      <div className="sp-peer-number">{call.from.number}</div>
      <div className="sp-call-actions">
        <button className="sp-round-btn danger" onClick={onReject} aria-label="Отклонить">
          <PhoneOff size={26} />
        </button>
        <button className="sp-round-btn primary" onClick={onAnswer} aria-label="Принять">
          <Phone size={26} />
        </button>
      </div>
    </section>
  );
}
