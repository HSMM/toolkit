// Design tokens. Палитра ровно из переданного UI-прототипа (объект C).
// Используется через inline styles (как в прототипе) и через CSS-переменные
// в src/styles/globals.css.

export const C = {
  bg: "#ffffff", bg2: "#fafafa", bg3: "#f4f4f5",
  border: "#e4e4e7", border2: "#d4d4d8",
  text: "#09090b", text2: "#71717a", text3: "#a1a1aa",
  acc: "#1E5AA8", accHov: "#164A8F",
  accBg: "#EFF4FB", accBg2: "#DBE7F5", accBrd: "#A3BEE0", accTx: "#143E73",
  err: "#ef4444", errBg: "#fef2f2", errBrd: "#fecaca", errTx: "#991b1b",
  warn: "#f59e0b", warnBg: "#fffbeb", warnBrd: "#fcd34d", warnTx: "#92400e",
  ok: "#10b981", okBg: "#ecfdf5", okBrd: "#a7f3d0", okTx: "#065f46",
  purp: "#a855f7", purpBg: "#faf5ff", purpBrd: "#d8b4fe", purpTx: "#7c3aed",
  card: "#ffffff",
} as const;

export const LOGO_URL =
  "https://via.placeholder.com/64x64/1E5AA8/ffffff?text=TK";

// Утилиты, идентичные тем что в прототипе — выносим, чтобы не таскать копипасту.
import type { CSSProperties } from "react";

export const inp = (): CSSProperties => ({
  width: "100%",
  padding: "9px 12px",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  fontSize: 14,
  color: C.text,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
  background: C.card,
  transition: "border-color .12s",
});
