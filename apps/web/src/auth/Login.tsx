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
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
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

  const requestReset = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setResetLoading(true);
    try {
      const res = await fetch("/oauth/password/reset/request", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: resetEmail || email }),
      });
      if (!res.ok) throw new Error(await readError(res, "Не удалось отправить письмо"));
      setResetSent(true);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Не удалось отправить письмо");
    } finally {
      setResetLoading(false);
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
        {!resetOpen ? <form onSubmit={submit} style={{ display: "grid", gap: 10, textAlign: "left", marginBottom: 14 }}>
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
          <div style={{ textAlign: "right", marginTop: -2 }}>
            <button type="button" onClick={() => { setResetOpen(true); setResetEmail(email); setErr(""); }}
              style={{ border: "none", background: "transparent", padding: 0, color: C.acc, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
              Забыли пароль?
            </button>
          </div>
          {err && <div style={{ color: C.err, fontSize: 12.5, lineHeight: 1.45 }}>{err}</div>}
          <button disabled={loading || !email.trim() || !password} style={{
            width: "100%", padding: "12px 16px", background: loading || !email.trim() || !password ? C.bg3 : C.acc, color: loading || !email.trim() || !password ? C.text3 : "white",
            border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: loading || !email.trim() || !password ? "default" : "pointer",
          }}>
            {loading ? "Входим…" : "Войти"}
          </button>
        </form> : <form onSubmit={requestReset} style={{ display: "grid", gap: 10, textAlign: "left", marginBottom: 14 }}>
          {!resetSent ? <>
            <div style={{ padding: 14, borderRadius: 12, background: C.bg2, border: `1px solid ${C.border}`, color: C.text2, fontSize: 13.5, lineHeight: 1.5 }}>
              Укажите email от аккаунта Toolkit. Если локальный пароль включён, отправим ссылку для восстановления.
            </div>
            <label style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.text2, fontWeight: 600 }}>
              Email
              <input value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} autoComplete="username" placeholder="email@company.by"
                style={{ height: 42, borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg2, color: C.text, padding: "0 12px", fontSize: 14, outline: "none" }} />
            </label>
            {err && <div style={{ color: C.err, fontSize: 12.5, lineHeight: 1.45 }}>{err}</div>}
            <button disabled={resetLoading || !resetEmail.trim()} style={{
              width: "100%", padding: "12px 16px", background: resetLoading || !resetEmail.trim() ? C.bg3 : C.acc, color: resetLoading || !resetEmail.trim() ? C.text3 : "white",
              border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: resetLoading || !resetEmail.trim() ? "default" : "pointer",
            }}>
              {resetLoading ? "Отправляем…" : "Отправить ссылку"}
            </button>
          </> : <div style={{ padding: 16, borderRadius: 12, background: "#ecfdf5", border: "1px solid #bbf7d0", color: "#166534", fontSize: 13.5, lineHeight: 1.55, textAlign: "center" }}>
            Если для этого email включён локальный пароль, письмо уже отправлено. Проверьте входящие и спам.
          </div>}
          <button type="button" onClick={() => { setResetOpen(false); setResetSent(false); setErr(""); }}
            style={{ width: "100%", padding: "11px 16px", background: C.card, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            Вернуться ко входу
          </button>
        </form>}
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

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (password.length < 8) {
      setErr("Пароль должен быть не короче 8 символов");
      return;
    }
    if (password !== password2) {
      setErr("Пароли не совпадают");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/oauth/password/reset/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) throw new Error(await readError(res, "Не удалось обновить пароль"));
      setStatus("done");
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Не удалось обновить пароль");
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
        background: C.card, padding: 38, borderRadius: 16, maxWidth: 430, width: "100%",
        border: `1px solid ${C.border}`, textAlign: "center",
      }}>
        <img src={LOGO_URL} alt="" width={48} height={48} style={{ borderRadius: 10, marginBottom: 18 }} />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>Новый пароль</h1>
        <p style={{ margin: "8px 0 22px", fontSize: 14, color: C.text2 }}>
          Задайте новый пароль для входа в Toolkit.
        </p>
        {status === "done" ? <>
          <div style={{ padding: 16, borderRadius: 12, background: "#ecfdf5", border: "1px solid #bbf7d0", color: "#166534", fontSize: 13.5, lineHeight: 1.55, marginBottom: 14 }}>
            Пароль обновлён. Теперь можно войти с новым паролем.
          </div>
          <button onClick={() => window.location.assign("/")} style={{
            width: "100%", padding: "12px 16px", background: C.acc, color: "white",
            border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>
            Перейти ко входу
          </button>
        </> : <form onSubmit={submit} style={{ display: "grid", gap: 10, textAlign: "left" }}>
          {!token && <div style={{ color: C.err, fontSize: 12.5, lineHeight: 1.45 }}>Ссылка восстановления неполная: нет токена.</div>}
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.text2, fontWeight: 600 }}>
            Новый пароль
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder="Не короче 8 символов"
              style={{ height: 42, borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg2, color: C.text, padding: "0 12px", fontSize: 14, outline: "none" }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.text2, fontWeight: 600 }}>
            Повторите пароль
            <input value={password2} onChange={(e) => setPassword2(e.target.value)} type="password" autoComplete="new-password" placeholder="Повторите пароль"
              style={{ height: 42, borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg2, color: C.text, padding: "0 12px", fontSize: 14, outline: "none" }} />
          </label>
          {err && <div style={{ color: C.err, fontSize: 12.5, lineHeight: 1.45 }}>{err}</div>}
          <button disabled={loading || !token || !password || !password2} style={{
            width: "100%", padding: "12px 16px", background: loading || !token || !password || !password2 ? C.bg3 : C.acc, color: loading || !token || !password || !password2 ? C.text3 : "white",
            border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: loading || !token || !password || !password2 ? "default" : "pointer",
          }}>
            {loading ? "Сохраняем…" : "Обновить пароль"}
          </button>
        </form>}
      </div>
    </div>
  );
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = await res.json() as { error?: { message?: string } };
    return payload.error?.message || fallback;
  } catch {
    return fallback;
  }
}
