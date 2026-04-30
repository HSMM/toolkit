import { LockKeyhole, Phone } from "lucide-react";
import { useState } from "react";

export function LoginScreen({ onLogin }: { onLogin: (credentials: { login: string; password: string; server: string }) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");
  const canSubmit = login.trim() !== "" && password.trim() !== "" && server.trim() !== "";

  return (
    <section className="sp-screen" style={{ display: "grid", alignContent: "center", minHeight: "100%" }} aria-label="Вход в софтфон">
      <form
        className="sp-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onLogin({ login, password, server });
        }}
      >
        <div style={{ display: "grid", justifyItems: "center", gap: 8, marginBottom: 16 }}>
          <span className="sp-round-btn" style={{ width: 56, height: 56 }}><Phone size={25} /></span>
          <strong style={{ fontSize: 22 }}>Софтфон</strong>
          <span className="sp-sub-text">Войдите в аккаунт</span>
        </div>
        <div className="sp-form">
          <label className="sp-label">Логин<input className="sp-input" value={login} onChange={(e) => setLogin(e.target.value)} /></label>
          <label className="sp-label">Пароль<input className="sp-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label className="sp-label">Сервер<input className="sp-input" value={server} onChange={(e) => setServer(e.target.value)} /></label>
          <button className="sp-btn" disabled={!canSubmit}><LockKeyhole size={18} /> Войти</button>
        </div>
      </form>
    </section>
  );
}
