import { Handshake, Hash, Home, Mic, MicOff, Pause, PhoneForwarded, PhoneOff, Plus, Speaker } from "lucide-react";
import { useEffect, useState } from "react";
import type { CallState } from "../types";
import { formatClock, initials } from "../utils";
import { playMuteToggleSound } from "../audio";

const dtmf = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type Props = {
  call: Extract<CallState, { kind: "active" }>;
  elapsedMs: number;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleSpeaker: () => void;
  onSendDtmf: (digit: string) => void;
  onTransfer: (number: string) => void;
  onAttendedTransfer: (number: string) => void;
  onJoin: (number?: string) => void;
  onHome: () => void;
};

export function ActiveCallScreen({
  call,
  elapsedMs,
  onHangup,
  onToggleMute,
  onToggleHold,
  onToggleSpeaker,
  onSendDtmf,
  onTransfer,
  onAttendedTransfer,
  onJoin,
  onHome,
}: Props) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  const showSpeaker = useMobileBrowser();

  return (
    <section className="sp-overlay sp-active-overlay" aria-label="Активный вызов">
      <div className="sp-active-top">
        <button className="sp-mini-call-btn" type="button" onClick={onHome} aria-label="Домой">
          <Home size={18} />
        </button>
        {showSpeaker && (
          <button
            className={`sp-mini-call-btn ${call.speakerOn ? "active" : ""}`}
            type="button"
            onClick={onToggleSpeaker}
            aria-label="Громкая связь"
          >
            <Speaker size={18} />
          </button>
        )}
      </div>

      <span className="sp-avatar medium">{initials(call.peer.name)}</span>
      <div className="sp-peer-name">{call.peer.name ?? call.peer.number}</div>
      <div className="sp-peer-number" style={{ fontVariantNumeric: "tabular-nums" }}>{formatClock(elapsedMs)}</div>

      <div className="sp-active-grid">
        <Action icon={<Hash size={22} />} label="Клавиши" active={keypadOpen} onClick={() => setKeypadOpen(true)} />
        <Action
          icon={call.muted ? <MicOff size={22} /> : <Mic size={22} />}
          label={call.muted ? "Включить" : "Без звука"}
          active={call.muted}
          onClick={() => {
            playMuteToggleSound();
            onToggleMute();
          }}
        />
        <Action icon={<Pause size={22} />} label="Удержать" active={call.onHold} onClick={onToggleHold} />
        <Action icon={<PhoneForwarded size={22} />} label="Перевод" onClick={() => promptNumber("Номер для перевода", onTransfer)} />
        <Action icon={<Plus size={22} />} label="Конференция" onClick={() => promptOptionalNumber("Номер/комната конференции", onJoin)} />
        <Action icon={<Handshake size={22} />} label="Сопровождение" onClick={() => promptNumber("Номер для перевода с консультацией", onAttendedTransfer)} />
      </div>

      <button className="sp-end-call-btn" type="button" onClick={onHangup} aria-label="Завершить вызов">
        <PhoneOff size={20} />
        Завершить
      </button>

      {keypadOpen && (
        <div className="sp-keypad-sheet" role="dialog" aria-label="DTMF клавиатура">
          <div className="sp-contact-head">
            <strong>Клавиатура</strong>
            <button className="sp-icon-btn" onClick={() => setKeypadOpen(false)}>Готово</button>
          </div>
          <div className="sp-keypad" style={{ marginTop: 10 }}>
            {dtmf.map((digit) => (
              <button key={digit} className="sp-key" onClick={() => onSendDtmf(digit)}>
                <span className="sp-key-digit">{digit}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function useMobileBrowser() {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const update = () => {
      const ua = navigator.userAgent || "";
      const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
      const touchSmallScreen = navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 820px)").matches;
      setMobile(mobileUa || touchSmallScreen);
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mobile;
}

function promptNumber(title: string, onSubmit: (number: string) => void) {
  const value = window.prompt(title);
  const number = value?.trim();
  if (number) onSubmit(number);
}

function promptOptionalNumber(title: string, onSubmit: (number?: string) => void) {
  const value = window.prompt(`${title} (можно оставить пустым)`);
  onSubmit(value?.trim() || undefined);
}

function Action({ icon, label, active, disabled, onClick }: { icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <span className="sp-action-cell">
      <button className={`sp-round-btn ${active ? "active" : ""}`} disabled={disabled} onClick={onClick} title={disabled ? "Скоро" : undefined}>
        {icon}
      </button>
      <span>{label}</span>
    </span>
  );
}
