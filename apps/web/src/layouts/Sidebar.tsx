// Боковая навигация. Свёртывание / разворачивание иконок — как в прототипе.
// Заглушки модулей (Мессенджеры/Контакты/Хелпдэск) помечены бейджем "скоро".

import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Phone, Video, FileText, MessageSquare, Users, HelpCircle, Settings,
  ChevronRight, type LucideIcon,
} from "lucide-react";

import { C, LOGO_URL } from "@/styles/tokens";
import { useT } from "@/i18n";

type Item = {
  to: string;
  Icon: LucideIcon;
  labelKey: string;
  stub?: boolean;
  adminOnly?: boolean;
};

const ITEMS: Item[] = [
  { to: "/phone",       Icon: Phone,         labelKey: "nav.phone" },
  { to: "/meet",        Icon: Video,         labelKey: "nav.meet" },
  { to: "/transcripts", Icon: FileText,      labelKey: "nav.transcripts" },
  { to: "/messengers",  Icon: MessageSquare, labelKey: "nav.messengers", stub: true },
  { to: "/contacts",    Icon: Users,         labelKey: "nav.contacts",   stub: true },
  { to: "/helpdesk",    Icon: HelpCircle,    labelKey: "nav.helpdesk",   stub: true },
];

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useT();

  const items: Item[] = isAdmin
    ? [...ITEMS, { to: "/admin", Icon: Settings, labelKey: "nav.admin", adminOnly: true }]
    : ITEMS;

  return (
    <aside style={{
      width: expanded ? 220 : 60,
      background: C.bg2,
      borderRight: `1px solid ${C.border}`,
      display: "flex", flexDirection: "column",
      transition: "width 160ms ease",
      overflow: "hidden",
      flexShrink: 0,
    }}>
      <div style={{ padding: "14px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <img src={LOGO_URL} alt="" width={28} height={28} style={{ flexShrink: 0, borderRadius: 6 }}/>
        <span style={{
          fontSize: 15, fontWeight: 600, color: C.text,
          opacity: expanded ? 1 : 0, transition: "opacity 120ms",
        }}>{t("app.title")}</span>
      </div>

      <nav style={{ flex: 1, paddingTop: 4 }}>
        {items.map(it => (
          <NavLink key={it.to} to={it.to}
            title={!expanded ? t(it.labelKey) : undefined}
            style={({ isActive }) => ({
              display: "flex", alignItems: "center", gap: 11,
              width: "calc(100% - 8px)", margin: "1px 4px",
              padding: "9px 12px", borderRadius: 8,
              background: isActive ? C.bg3 : "transparent",
              color: isActive ? C.text : C.text2,
              transition: "background 120ms, color 120ms",
              position: "relative", textDecoration: "none",
              overflow: "hidden", whiteSpace: "nowrap",
              fontWeight: isActive ? 600 : 500,
              fontSize: 13.5,
            })}>
            {({ isActive }) => (
              <>
                <it.Icon size={18} style={{ flexShrink: 0 }} strokeWidth={isActive ? 2.1 : 1.75}/>
                <span style={{
                  flex: 1, opacity: expanded ? 1 : 0, transition: "opacity 120ms",
                }}>{t(it.labelKey)}</span>
                {it.stub && expanded && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, background: C.bg,
                    border: `1px solid ${C.border}`, color: C.text3,
                    padding: "1px 6px", borderRadius: 4,
                  }}>скоро</span>
                )}
                {isActive && (
                  <div style={{
                    position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
                    width: 3, height: 18, background: C.acc, borderRadius: "0 2px 2px 0",
                  }}/>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <button onClick={() => setExpanded(e => !e)} title={expanded ? "Свернуть" : "Развернуть"}
        style={{
          margin: 8, padding: "8px 12px", borderRadius: 8,
          background: "transparent", color: C.text2, fontSize: 13,
          border: `1px solid ${C.border}`, display: "flex", alignItems: "center",
          gap: 8, justifyContent: expanded ? "flex-start" : "center",
        }}>
        <ChevronRight size={14} style={{
          transform: expanded ? "rotate(180deg)" : "none", transition: "transform .15s",
        }}/>
        {expanded && <span>Свернуть</span>}
      </button>
    </aside>
  );
}
