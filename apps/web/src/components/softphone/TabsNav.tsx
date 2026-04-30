import { Contact, History, Keyboard, type LucideIcon } from "lucide-react";
import type { SoftphoneTab } from "./types";

const tabs: { id: SoftphoneTab; label: string; Icon: LucideIcon }[] = [
  { id: "dialer", label: "Набор", Icon: Keyboard },
  { id: "recents", label: "История", Icon: History },
  { id: "contacts", label: "Контакты", Icon: Contact },
];

export function TabsNav({ value, onChange }: { value: SoftphoneTab; onChange: (tab: SoftphoneTab) => void }) {
  return (
    <nav className="sp-tabs" aria-label="Разделы софтфона">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`sp-tab ${value === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
          aria-label={tab.label}
          title={tab.label}
        >
          <tab.Icon size={21} />
        </button>
      ))}
    </nav>
  );
}
