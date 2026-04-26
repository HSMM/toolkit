// Тонкий fetch-обёртка над Toolkit API.
// Авторизация — JWT в заголовке Authorization: Bearer <token>.
// Refresh refresh-cookie выполняется вне этого слоя (см. auth/AuthContext).

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

let getAccessToken: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

/** Wires the access token getter — called once from AuthContext. */
export function configureApiClient(opts: {
  getAccessToken: () => string | null;
  onUnauthorized: () => void;
}) {
  getAccessToken = opts.getAccessToken;
  onUnauthorized = opts.onUnauthorized;
}

/**
 * api<T> — typed fetch.
 * Path is relative ("/api/v1/me"); base URL is implicit (same origin via Vite proxy / NPM).
 */
export async function api<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...opts.headers,
  };

  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body,
    signal: opts.signal,
    credentials: "include", // refresh cookie HttpOnly
  });

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "Unauthorized", "session expired");
  }

  if (!res.ok) {
    let payload: unknown = undefined;
    try { payload = await res.json(); } catch { /* non-JSON body */ }
    const e = (payload as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(
      res.status,
      e?.code ?? res.statusText ?? "error",
      e?.message ?? `HTTP ${res.status}`,
      payload,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
