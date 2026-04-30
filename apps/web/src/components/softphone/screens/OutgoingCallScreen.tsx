import { PhoneCall, PhoneOff } from "lucide-react";
import type { CallState } from "../types";

type Props = {
  call: Extract<CallState, { kind: "dialing" }>;
  onHangup: () => void;
};

export function OutgoingCallScreen({ call, onHangup }: Props) {
  const label = call.phase === "ringing" ? "Вызов..." : "Соединение...";

  return (
    <section className="sp-overlay sp-outgoing-overlay" aria-label="Исходящий вызов">
      <div className="sp-overlay-title">{label}</div>
      <span className="sp-avatar large sp-outgoing-avatar">
        <PhoneCall size={42} />
      </span>
      <div className="sp-peer-name">{call.to.name ?? call.to.number}</div>
      <div className="sp-peer-number">
        {call.to.number}{call.earlyMedia ? " · гудок от АТС" : ""}
      </div>
      <div className="sp-dialing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <div className="sp-call-actions">
        <button className="sp-round-btn danger" onClick={onHangup} aria-label="Сбросить">
          <PhoneOff size={26} />
        </button>
      </div>
    </section>
  );
}
