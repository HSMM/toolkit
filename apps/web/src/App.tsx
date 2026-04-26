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
import { LoginPage } from "@/auth/Login";
import { Loading, ErrorBox } from "@/components/states";
import { useMe } from "@/api/me";
import { Shell } from "@/Shell";

export function App() {
  const { state } = useAuth();

  if (state.status === "loading")   return <Loading label="Восстанавливаем сессию…" />;
  if (state.status === "anonymous") return <LoginPage />;
  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.isError)   return <ErrorBox message={String(me.error)} onRetry={() => { void me.refetch(); }} />;
  if (!me.data)     return <Loading />;
  return <Shell me={me.data} />;
}
