// Страница логина. Полный экран — только до первой авторизации,
// дальше пользователь живёт под AppLayout.
//
// Пользователь может войти локально по email/password или через Bitrix24 OAuth.

import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { C, LOGO_URL } from "@/styles/tokens";
import { useT } from "@/i18n";

export function LoginPage() {
  const { login, loginPassword } = useAuth();
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await loginPassword(email, password);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Не удалось войти");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.bg2, padding: 24,
    }}>
      <div style={{
        background: C.card, padding: 38, borderRadius: 16, maxWidth: 410, width: "100%",
        border: `1px solid ${C.border}`, textAlign: "center",
      }}>
        <img src={LOGO_URL} alt="" width={48} height={48} style={{ borderRadius: 10, marginBottom: 18 }}/>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>{t("login.title")}</h1>
        <p style={{ margin: "8px 0 22px", fontSize: 14, color: C.text2 }}>{t("login.subtitle")}</p>
        <form onSubmit={submit} style={{ display: "grid", gap: 10, textAlign: "left", marginBottom: 14 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.text2, fontWeight: 600 }}>
            Логин
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="email@company.by"
              style={{ height: 42, borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg2, color: C.text, padding: "0 12px", fontSize: 14, outline: "none" }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.text2, fontWeight: 600 }}>
            Пароль
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" placeholder="••••••••"
              style={{ height: 42, borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg2, color: C.text, padding: "0 12px", fontSize: 14, outline: "none" }} />
          </label>
          {err && <div style={{ color: C.err, fontSize: 12.5, lineHeight: 1.45 }}>{err}</div>}
          <button disabled={loading || !email.trim() || !password} style={{
            width: "100%", padding: "12px 16px", background: loading || !email.trim() || !password ? C.bg3 : C.acc, color: loading || !email.trim() || !password ? C.text3 : "white",
            border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: loading || !email.trim() || !password ? "default" : "pointer",
          }}>
            {loading ? "Входим…" : "Войти"}
          </button>
        </form>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0", color: C.text3, fontSize: 12 }}>
          <span style={{ height: 1, background: C.border, flex: 1 }} />
          <span>или</span>
          <span style={{ height: 1, background: C.border, flex: 1 }} />
        </div>
        <button onClick={() => login()} style={{
          width: "100%", padding: "12px 16px", background: C.card, color: C.text,
          border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>
          {t("login.cta")}
        </button>
      </div>
    </div>
  );
}
