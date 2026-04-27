// useSoftphone — хук-обёртка над JsSIP для подключения к FreePBX через WSS.
// Регистрация, исходящие, входящие, mute/hold/hang-up, простая call-история.
//
// Конфигурация берётся из системных настроек телефонии:
//   • WSS-адрес (sysset.PhoneConfig.wss_url) — пока не реализован, ждём
//     отдельный endpoint; временно читаем из window.__TOOLKIT_PHONE__ или
//     sessionStorage для разработческой проверки.
//   • extension/пароль — те же. В первой версии можно вбить вручную через
//     Настройки → Телефония → WebRTC шлюз.
// Если креды не заданы — статус NotConfigured, всё disabled.

import { useEffect, useRef, useState } from "react";
import JsSIP from "jssip";
import type { RTCSession } from "jssip/lib/RTCSession";
import type { UA } from "jssip/lib/UA";

export type SoftphoneState =
  | { kind: "not_configured" }
  | { kind: "connecting" }
  | { kind: "registered" }
  | { kind: "registration_failed"; cause: string }
  | { kind: "incoming";   from: string; sessionId: string }
  | { kind: "outgoing";   to: string;   sessionId: string }
  | { kind: "active";     peer: string; sessionId: string; startedAt: number; muted: boolean; held: boolean }
  | { kind: "ended";      reason: string };

export type SoftphoneConfig = {
  wssUrl: string;        // wss://pbx.example.com:8089/ws
  extension: string;     // 1012
  password: string;      // SIP-пароль extension'а
  domain?: string;       // если отличается от хоста WSS
  displayName?: string;  // имя в From: header
};

// Простой слушатель входящих звонков для показа OS-notification и UI-popup'а.
export type SoftphoneCallbacks = {
  onIncoming?: (from: string) => void;
  onError?: (msg: string) => void;
};

const STORAGE_KEY = "toolkit:softphone";

// Загрузить креды из sessionStorage (или window override). Backend-эндпоинт
// для хранения добавится позже; сейчас — самая простая схема для запуска.
export function loadSoftphoneConfig(): SoftphoneConfig | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SoftphoneConfig;
  } catch { /* noop */ }
  // window-override используется в dev: window.__TOOLKIT_PHONE__ = {...}
  const w = (window as unknown as { __TOOLKIT_PHONE__?: SoftphoneConfig }).__TOOLKIT_PHONE__;
  return w ?? null;
}
export function saveSoftphoneConfig(c: SoftphoneConfig | null) {
  if (!c) sessionStorage.removeItem(STORAGE_KEY);
  else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function useSoftphone(callbacks?: SoftphoneCallbacks) {
  const [state, setState] = useState<SoftphoneState>({ kind: "not_configured" });
  const uaRef = useRef<UA | null>(null);
  const sessionRef = useRef<RTCSession | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Создаём <audio> для remote-стрима один раз.
  useEffect(() => {
    const a = document.createElement("audio");
    a.autoplay = true;
    audioRef.current = a;
    return () => { a.remove(); };
  }, []);

  const teardownSession = () => {
    sessionRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  const start = (cfg: SoftphoneConfig) => {
    if (uaRef.current) {
      try { uaRef.current.stop(); } catch { /* noop */ }
      uaRef.current = null;
    }
    setState({ kind: "connecting" });
    const socket = new JsSIP.WebSocketInterface(cfg.wssUrl);
    const domain = cfg.domain || hostFromWss(cfg.wssUrl);
    const ua = new JsSIP.UA({
      uri: `sip:${cfg.extension}@${domain}`,
      password: cfg.password,
      sockets: [socket],
      display_name: cfg.displayName || cfg.extension,
      register: true,
      session_timers: false,
    });
    uaRef.current = ua;

    ua.on("registered", () => setState({ kind: "registered" }));
    ua.on("unregistered", () => setState({ kind: "registration_failed", cause: "unregistered" }));
    ua.on("registrationFailed", (e: { cause?: string }) =>
      setState({ kind: "registration_failed", cause: e.cause || "unknown" }));

    ua.on("newRTCSession", (data: { session: RTCSession; originator: string }) => {
      const s = data.session;
      sessionRef.current = s;

      const peer = (s.remote_identity?.uri?.user as string | undefined)
        || (s.remote_identity?.display_name as string | undefined)
        || "unknown";

      if (data.originator === "remote") {
        setState({ kind: "incoming", from: peer, sessionId: s.id });
        callbacks?.onIncoming?.(peer);
      } else {
        setState({ kind: "outgoing", to: peer, sessionId: s.id });
      }

      s.on("accepted", () => {
        setState({
          kind: "active", peer,
          sessionId: s.id, startedAt: Date.now(),
          muted: false, held: false,
        });
      });
      s.on("ended", () => {
        teardownSession();
        setState({ kind: "ended", reason: "ended" });
        // через 2 секунды возвращаем в "registered"
        setTimeout(() => setState({ kind: "registered" }), 2000);
      });
      s.on("failed", (ev: { cause?: string }) => {
        teardownSession();
        setState({ kind: "ended", reason: ev.cause || "failed" });
        setTimeout(() => setState({ kind: "registered" }), 2000);
      });
      s.on("peerconnection", () => {
        // Привязываем remote-стрим как только peer connection появляется.
        const pc = s.connection as RTCPeerConnection | undefined;
        if (!pc) return;
        pc.addEventListener("track", (ev) => {
          if (audioRef.current && ev.streams[0]) {
            audioRef.current.srcObject = ev.streams[0];
          }
        });
      });
    });

    try { ua.start(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacks?.onError?.(msg);
      setState({ kind: "registration_failed", cause: msg });
    }
  };

  const stop = () => {
    if (uaRef.current) {
      try { uaRef.current.stop(); } catch { /* noop */ }
      uaRef.current = null;
    }
    teardownSession();
    setState({ kind: "not_configured" });
  };

  const dial = (to: string) => {
    if (!uaRef.current) return;
    if (!to.trim()) return;
    try {
      uaRef.current.call(to, {
        mediaConstraints: { audio: true, video: false },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
    } catch (e) {
      callbacks?.onError?.(e instanceof Error ? e.message : String(e));
    }
  };

  const answer = () => {
    if (!sessionRef.current) return;
    try { sessionRef.current.answer({ mediaConstraints: { audio: true, video: false } }); }
    catch (e) { callbacks?.onError?.(e instanceof Error ? e.message : String(e)); }
  };

  const hangup = () => {
    if (!sessionRef.current) return;
    try { sessionRef.current.terminate(); } catch { /* noop */ }
    teardownSession();
  };

  const toggleMute = () => {
    const s = sessionRef.current;
    if (!s || state.kind !== "active") return;
    if (state.muted) { s.unmute(); setState({ ...state, muted: false }); }
    else             { s.mute();   setState({ ...state, muted: true }); }
  };

  const toggleHold = () => {
    const s = sessionRef.current;
    if (!s || state.kind !== "active") return;
    if (state.held) { s.unhold(); setState({ ...state, held: false }); }
    else            { s.hold();   setState({ ...state, held: true }); }
  };

  // Cleanup при размонтировании
  useEffect(() => () => { stop(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return { state, start, stop, dial, answer, hangup, toggleMute, toggleHold };
}

function hostFromWss(wss: string): string {
  try {
    const u = new URL(wss);
    return u.hostname;
  } catch {
    return wss.replace(/^wss?:\/\//, "").split("/")[0]!.split(":")[0]!;
  }
}
