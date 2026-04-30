import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Search } from "lucide-react";
import type { CallDirection, HistoryItem } from "../types";
import { formatClock, formatDate, initials } from "../utils";

type Props = {
  history: HistoryItem[];
  query: string;
  onQuery: (value: string) => void;
  onDial: (number: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
};

export function RecentsScreen({ history, query, onQuery, onDial, onDelete, onClear }: Props) {
  const filtered = history.filter((item) => `${item.name ?? ""} ${item.number}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <section className="sp-screen" aria-label="История вызовов">
      <div className="sp-field-wrap" style={{ marginBottom: 10 }}>
        <Search className="sp-search-icon" size={16} />
        <input className="sp-field" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Поиск..." aria-label="Поиск по истории" />
      </div>
      {history.length > 0 && (
        <button className="sp-icon-btn" onClick={onClear} style={{ width: "auto", padding: "0 10px", marginBottom: 4 }} aria-label="Очистить историю">
          Очистить
        </button>
      )}
      <div className="sp-list">
        {filtered.length === 0 ? <div className="sp-empty">История пуста</div> : filtered.map((item) => (
          <button
            key={item.id}
            className="sp-list-row"
            onClick={() => onDial(item.number)}
            onContextMenu={(e) => { e.preventDefault(); onDelete(item.id); }}
            title="Правый клик удаляет запись"
          >
            <span className="sp-avatar">{initials(item.name)}</span>
            <span style={{ minWidth: 0 }}>
              <span className="sp-main-text">{item.name ?? item.number}</span>
              <span className="sp-sub-text">
                {item.name ? item.number : ""}{item.name ? " · " : ""}{formatDate(item.timestamp)}
                {item.durationSec !== undefined ? ` · ${formatClock(item.durationSec * 1000)}` : ""}
              </span>
            </span>
            <span className={`sp-badge sp-call-direction ${item.direction}`} aria-label={directionLabel(item.direction)} title={directionLabel(item.direction)}>
              {directionIcon(item.direction)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function directionIcon(direction: CallDirection) {
  if (direction === "incoming") return <PhoneIncoming size={16} />;
  if (direction === "outgoing") return <PhoneOutgoing size={16} />;
  return <PhoneMissed size={16} />;
}

function directionLabel(direction: CallDirection) {
  if (direction === "incoming") return "Входящий звонок";
  if (direction === "outgoing") return "Исходящий звонок";
  return "Пропущенный звонок";
}
