// Унифицированные состояния — Empty / Loading / ErrorBox.
// Стиль ровно из прототипа (объект C из styles/tokens.ts).

import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { C } from "@/styles/tokens";

export function Empty({
  Icon = Inbox,
  title,
  sub,
  action,
}: {
  Icon?: LucideIcon;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{
      padding: "60px 24px", textAlign: "center",
      display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14, background: C.bg3,
        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16,
      }}>
        <Icon size={24} color={C.text3} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.55, maxWidth: 340 }}>{sub}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Loading({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div style={{
      padding: "60px 24px", display: "flex", flexDirection: "column",
      alignItems: "center", color: C.text2,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${C.bg3}`, borderTopColor: C.acc,
        animation: "tk-spin .8s linear infinite", marginBottom: 12,
      }}/>
      <div style={{ fontSize: 13 }}>{label}</div>
      <style>{`@keyframes tk-spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export function ErrorBox({
  title = "Что-то пошло не так",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div style={{
      margin: 24, padding: 18, borderRadius: 10,
      background: C.errBg, border: `1px solid ${C.errBrd}`, color: C.errTx,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {message && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{message}</div>}
      {onRetry && (
        <button onClick={onRetry} style={{
          marginTop: 10, padding: "6px 12px", borderRadius: 6,
          background: C.card, color: C.errTx, border: `1px solid ${C.errBrd}`,
          fontSize: 13, fontWeight: 500, cursor: "pointer",
        }}>
          Попробовать снова
        </button>
      )}
    </div>
  );
}
