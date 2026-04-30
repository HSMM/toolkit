import { Plus, Phone, Search } from "lucide-react";
import type { Contact } from "../types";
import { initials, primaryNumber } from "../utils";

type Props = {
  contacts: Contact[];
  query: string;
  onQuery: (value: string) => void;
  onDial: (number: string) => void;
  onOpen: (contact: Contact | null) => void;
};

export function ContactsScreen({ contacts, query, onQuery, onDial, onOpen }: Props) {
  const filtered = contacts.filter((contact) =>
    `${contact.name} ${contact.department ?? ""} ${contact.numbers.map((n) => n.value).join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <section className="sp-screen" aria-label="Контакты">
      <div className="sp-contact-head">
        <div className="sp-field-wrap" style={{ flex: 1 }}>
          <Search className="sp-search-icon" size={16} />
          <input className="sp-field" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Поиск контактов..." aria-label="Поиск контактов" />
        </div>
        <button className="sp-icon-btn" onClick={() => onOpen(null)} aria-label="Создать контакт">
          <Plus size={18} />
        </button>
      </div>
      <div className="sp-list">
        {filtered.length === 0 ? <div className="sp-empty">Контакты не найдены</div> : filtered.map((contact) => (
          <button key={contact.id} className="sp-list-row" onClick={() => onOpen(contact)}>
            <span className="sp-avatar">{initials(contact.name)}</span>
            <span style={{ minWidth: 0 }}>
              <span className="sp-main-text">{contact.name}</span>
              <span className="sp-sub-text">{primaryNumber(contact)}</span>
              {contact.department && <span className="sp-sub-text" style={{ display: "block" }}>{contact.department}</span>}
            </span>
            <span
              role="button"
              tabIndex={0}
              className="sp-icon-btn"
              onClick={(e) => { e.stopPropagation(); onDial(primaryNumber(contact)); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onDial(primaryNumber(contact)); }
              }}
              aria-label={`Позвонить ${contact.name}`}
            >
              <Phone size={18} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
