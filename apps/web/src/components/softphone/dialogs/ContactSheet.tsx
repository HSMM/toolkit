import { Phone, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Contact } from "../types";

type Props = {
  contact: Contact | null;
  onClose: () => void;
  onDial: (number: string) => void;
  onCreate: (contact: Omit<Contact, "id">) => void;
  onUpdate: (contact: Contact) => void;
  onDelete: (id: string) => void;
};

export function ContactSheet({ contact, onClose, onDial, onCreate, onUpdate, onDelete }: Props) {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [department, setDepartment] = useState("");

  useEffect(() => {
    setName(contact?.name ?? "");
    setNumber(contact?.numbers[0]?.value ?? "");
    setDepartment(contact?.department ?? "");
  }, [contact]);

  const save = () => {
    const next = { name: name.trim(), department: department.trim() || undefined, numbers: [{ type: "work" as const, value: number.trim() }] };
    if (!next.name || !next.numbers[0].value) return;
    if (contact) onUpdate({ ...contact, ...next });
    else onCreate(next);
    onClose();
  };

  return (
    <aside className="sp-sheet-panel" aria-label={contact ? "Карточка контакта" : "Новый контакт"}>
      <div className="sp-contact-head">
        <strong>{contact ? "Контакт" : "Новый контакт"}</strong>
        <button className="sp-icon-btn" onClick={onClose} aria-label="Закрыть">Esc</button>
      </div>
      <div className="sp-form">
        <label className="sp-label">Имя<input className="sp-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="sp-label">Рабочий номер<input className="sp-input" value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" /></label>
        <label className="sp-label">Отдел<input className="sp-input" value={department} onChange={(e) => setDepartment(e.target.value)} /></label>
        <button className="sp-btn" onClick={save}>Сохранить</button>
        {number && <button className="sp-btn secondary" onClick={() => onDial(number)}><Phone size={18} /> Позвонить</button>}
        {contact && (
          <button
            className="sp-btn danger"
            onClick={() => {
              onDelete(contact.id);
              onClose();
            }}
          >
            <Trash2 size={18} /> Удалить
          </button>
        )}
      </div>
    </aside>
  );
}
