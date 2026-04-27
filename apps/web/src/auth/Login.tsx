// Страница логина. Полный экран — только до первой авторизации,
// дальше пользователь живёт под AppLayout.
//
// CTA "Войти через Bitrix24" → window.location → /oauth/login.

import { useAuth } from "./AuthContext";
import { C, LOGO_URL } from "@/styles/tokens";
import { useT } from "@/i18n";

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useT();

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.bg2, padding: 24,
    }}>
      <div style={{
        background: C.card, padding: 40, borderRadius: 16, maxWidth: 380, width: "100%",
        border: `1px solid ${C.border}`, textAlign: "center",
      }}>
        <img src={LOGO_URL} alt="" width={48} height={48} style={{ borderRadius: 10, marginBottom: 18 }}/>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>{t("login.title")}</h1>
        <p style={{ margin: "8px 0 24px", fontSize: 14, color: C.text2 }}>{t("login.subtitle")}</p>
        <button onClick={() => login()} style={{
          width: "100%", padding: "12px 16px", background: C.acc, color: "white",
          border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>
          {t("login.cta")}
        </button>
      </div>
    </div>
  );
}
