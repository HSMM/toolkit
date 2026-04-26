// Auth-context: хранит текущий access-токен в памяти, рефрешит его через
// /oauth/refresh когда сервер возвращает 401, инвалидирует на logout.
//
// Refresh-токен живёт в HttpOnly Secure cookie, JS его не видит — это и нужно.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { configureApiClient } from "@/api/client";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; accessToken: string };

type AuthCtx = {
  state: AuthState;
  /** Запускает OAuth-flow: window.location → /oauth/login. */
  login: (returnTo?: string) => void;
  /** Удаляет сессию на сервере и сбрасывает состояние. */
  logout: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const tokenRef = useRef<string | null>(null);

  const setAuth = useCallback((token: string) => {
    tokenRef.current = token;
    setState({ status: "authenticated", accessToken: token });
  }, []);

  const setAnon = useCallback(() => {
    tokenRef.current = null;
    setState({ status: "anonymous" });
  }, []);

  // Один раз — пробуем восстановить access по refresh-cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/oauth/refresh", { method: "POST", credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setAnon();
          return;
        }
        const { access_token } = (await res.json()) as { access_token: string };
        if (!cancelled) setAuth(access_token);
      } catch {
        if (!cancelled) setAnon();
      }
    })();
    return () => { cancelled = true; };
  }, [setAuth, setAnon]);

  // Wire fetch-клиент.
  useEffect(() => {
    configureApiClient({
      getAccessToken: () => tokenRef.current,
      onUnauthorized: () => setAnon(),
    });
  }, [setAnon]);

  const login = useCallback((returnTo: string = window.location.pathname) => {
    const url = `/oauth/login?return_to=${encodeURIComponent(returnTo)}`;
    window.location.assign(url);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/oauth/logout", { method: "POST", credentials: "include" });
    } finally {
      setAnon();
    }
  }, [setAnon]);

  const value = useMemo<AuthCtx>(() => ({ state, login, logout }), [state, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth: AuthProvider missing");
  return v;
}
