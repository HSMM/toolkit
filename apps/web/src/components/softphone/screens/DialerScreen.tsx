import { useEffect, useRef } from "react";
import { Delete, Phone } from "lucide-react";
import type { CallState, RegistrationStatus } from "../types";
import { isEditableTarget } from "../utils";
import { playDtmfTone } from "../audio";

const keys = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
] as const;

type Props = {
  number: string;
  setNumber: (value: string) => void;
  registration: RegistrationStatus;
  call: CallState;
  onDial: (number: string) => void;
};

export function DialerScreen({ number, setNumber, registration, call, onDial }: Props) {
  const canCall = number.trim() !== "" && registration === "online" && call.kind === "idle";
  const longPressRef = useRef<number | null>(null);

  const append = (digit: string) => {
    playDtmfTone(digit);
    setNumber(number + digit);
  };

  const dial = () => {
    if (canCall) onDial(number.trim());
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (/^[0-9*#]$/.test(event.key)) {
        event.preventDefault();
        playDtmfTone(event.key);
        setNumber(number + event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        setNumber(number.slice(0, -1));
      } else if (event.key === "Enter" && canCall) {
        event.preventDefault();
        onDial(number.trim());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canCall, number, onDial, setNumber]);

  return (
    <section className="sp-screen sp-dialer-screen" aria-label="Набор номера">
      <div className="sp-dialer-display">
        <div className="sp-field-wrap">
          <input
            className="sp-field sp-dial-input"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/[^\d*#+]/g, ""))}
            placeholder="Введите номер"
            inputMode="tel"
            aria-label="Введите номер"
          />
          {number && (
            <button className="sp-icon-btn sp-backspace" onClick={() => setNumber(number.slice(0, -1))} aria-label="Удалить символ">
              <Delete size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="sp-dialer-bottom">
        <div className="sp-keypad">
          {keys.map(([digit, letters]) => (
            <button
              key={digit}
              className="sp-key"
              onClick={() => append(digit)}
              onPointerDown={() => {
                if (digit !== "0") return;
                longPressRef.current = window.setTimeout(() => setNumber(number.startsWith("+") ? number : `+${number}`), 500);
              }}
              onPointerUp={() => {
                if (longPressRef.current !== null) window.clearTimeout(longPressRef.current);
                longPressRef.current = null;
              }}
            >
              <span className="sp-key-digit">{digit}</span>
              <span className="sp-key-letters">{letters}</span>
            </button>
          ))}
        </div>
        <button className="sp-btn" disabled={!canCall} onClick={dial}>
          <Phone size={19} /> Позвонить
        </button>
      </div>
    </section>
  );
}
