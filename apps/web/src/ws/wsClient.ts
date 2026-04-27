// WebSocket-клиент для /api/v1/ws.
// Соответствует серверному hub'у из apps/api/internal/ws/hub.go.
//
// - Auth: JWT передаётся в Sec-WebSocket-Protocol (нестандартно, но единственный
//   способ доставить bearer-токен через WS-upgrade без cookie). Сервер ожидает
//   формат "bearer.<token>". Альтернативно — query-параметр ?token= на dev,
//   на prod — Authorization обрабатывается reverse-proxy.
// - Reconnect: экспоненциальный backoff [1s, 2s, 4s, 8s, max 30s].
// - Subscribe: handlers на тип события (incoming_call, transcript_ready, ...).

export type WsEvent<T = unknown> = {
  type: string;
  payload?: T;
  issued_at: string;
};

export type WsHandler<T = unknown> = (event: WsEvent<T>) => void;

export type WsClientOptions = {
  url?: string;
  getAccessToken: () => string | null;
  onConnect?: () => void;
  onDisconnect?: (code: number, reason: string) => void;
  onError?: (e: Event) => void;
};

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private wildcard = new Set<WsHandler>();
  private reconnectAttempts = 0;
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  /** Подписка на события. Возвращает unsubscribe. type='*' — на всё. */
  on<T = unknown>(type: string, handler: WsHandler<T>): () => void {
    const set = type === "*" ? this.wildcard : this.handlers.get(type) ?? new Set();
    if (type !== "*") this.handlers.set(type, set);
    set.add(handler as WsHandler);
    return () => { set.delete(handler as WsHandler); };
  }

  /** Открыть соединение. Идемпотентно. */
  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const token = this.opts.getAccessToken();
    if (!token) {
      // Без токена не идём — ждём, пока auth перейдёт в authenticated.
      return;
    }

    const url = this.opts.url ?? this.defaultUrl();
    // Передаём токен через subprotocol (см. JSDoc выше).
    this.ws = new WebSocket(url, ["bearer." + token]);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.opts.onConnect?.();
    };

    this.ws.onmessage = (evt) => {
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(evt.data) as WsEvent;
      } catch {
        return;
      }
      const set = this.handlers.get(parsed.type);
      if (set) for (const h of set) h(parsed);
      for (const h of this.wildcard) h(parsed);
    };

    this.ws.onerror = (e) => this.opts.onError?.(e);

    this.ws.onclose = (e) => {
      this.opts.onDisconnect?.(e.code, e.reason);
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
  }

  /** Закрыть и больше не переподключаться. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, "client closing");
    this.ws = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private defaultUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/v1/ws`;
  }
}
