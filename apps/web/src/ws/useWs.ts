// React-хук поверх WsClient: единственное соединение на всё приложение,
// открывается только когда пользователь аутентифицирован.

import { useEffect, useRef } from "react";
import { useAuth } from "@/auth/AuthContext";
import { WsClient, WsEvent, WsHandler } from "./wsClient";

let singleton: WsClient | null = null;

export function useWsClient(): WsClient | null {
  const { state } = useAuth();
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (state.status !== "authenticated") {
      // На logout/expiry закрываем сокет.
      singleton?.close();
      singleton = null;
      clientRef.current = null;
      return;
    }
    if (singleton) {
      clientRef.current = singleton;
      return;
    }
    singleton = new WsClient({
      getAccessToken: () => (state.status === "authenticated" ? state.accessToken : null),
    });
    singleton.connect();
    clientRef.current = singleton;
  }, [state]);

  return clientRef.current;
}

/** Подписка на конкретный тип события — чистая удобная обёртка. */
export function useWsEvent<T = unknown>(type: string, handler: WsHandler<T>): void {
  const client = useWsClient();
  // Стабильный ref, чтобы не пересоздавать подписку на каждый re-render.
  const handlerRef = useRef<WsHandler<T>>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!client) return;
    return client.on<T>(type, (e) => handlerRef.current(e));
  }, [client, type]);
}

export type { WsEvent };
