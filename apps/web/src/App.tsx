// Корневой роутер приложения.
//
// Логика:
//  - state.loading      → Loading (восстанавливаем сессию)
//  - state.anonymous    → LoginPage (CTA на /oauth/login)
//  - state.authenticated→ Shell (полный UI портала)
//
// Внутренняя навигация портала — на state в Shell.tsx (как в исходном
// прототипе). React Router используется только для login-flow и для будущих
// прямых ссылок на отдельные модули (например, /phone в закреплённой вкладке).

import { useAuth } from "@/auth/AuthContext";
import { LoginPage, ResetPasswordPage } from "@/auth/Login";
import { Loading, ErrorBox } from "@/components/states";
import { useMe } from "@/api/me";
import { Shell } from "@/Shell";
import { GuestPage } from "@/GuestPage";
import { SoftphonePage } from "@/SoftphonePage";

// Публичные пути — обходят auth gate.
function publicRoute(): { kind: "guest"; token: string } | { kind: "reset-password" } | null {
  const m = window.location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { kind: "guest", token: m[1]! };
  if (window.location.pathname === "/reset-password") return { kind: "reset-password" };
  return null;
}

export function App() {
  const pub = publicRoute();
  if (pub?.kind === "guest") return <GuestPage token={pub.token} />;
  if (pub?.kind === "reset-password") return <ResetPasswordPage />;

  const { state } = useAuth();

  if (state.status === "loading")   return <Loading label="Восстанавливаем сессию…" />;
  if (state.status === "anonymous") return <LoginPage />;
  if (window.location.pathname === "/softphone") {
    return <SoftphonePage />;
  }
  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.isError)   return <ErrorBox message={String(me.error)} onRetry={() => { void me.refetch(); }} />;
  if (!me.data)     return <Loading />;
  return <Shell me={me.data} />;
}
