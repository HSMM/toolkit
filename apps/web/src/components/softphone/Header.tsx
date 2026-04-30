import { Power, Settings } from "lucide-react";
import type { RegistrationStatus } from "./types";

type Props = {
  registration: RegistrationStatus;
  userNumber?: string;
  onSettings: () => void;
  onLogout: () => void;
};

const labels: Record<RegistrationStatus, string> = {
  offline: "Офлайн",
  connecting: "Подключение",
  online: "Онлайн",
  error: "Ошибка регистрации",
};

export function Header({ registration, userNumber, onSettings, onLogout }: Props) {
  return (
    <header className="sp-header">
      <div style={{ minWidth: 0 }}>
        <div className="sp-title">
          Софтфон
          {userNumber && <> <span className="sp-user-number">• {userNumber}</span></>}
        </div>
        <div className="sp-status">
          <span className={`sp-dot ${registration}`} />
          <span>{labels[registration]}</span>
        </div>
      </div>
      <div className="sp-icon-row">
        <button className="sp-icon-btn" onClick={onSettings} aria-label="Настройки">
          <Settings size={18} />
        </button>
        <button className="sp-icon-btn" onClick={onLogout} aria-label="Выйти">
          <Power size={18} />
        </button>
      </div>
    </header>
  );
}
