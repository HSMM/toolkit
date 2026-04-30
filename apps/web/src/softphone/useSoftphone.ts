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
import { playAnsweredBeep, startOutgoingRingback, stopOutgoingRingback } from "@/components/softphone/audio";

export type SoftphoneState =
  | { kind: "not_configured" }
  | { kind: "connecting" }
  | { kind: "registered" }
  | { kind: "registration_failed"; cause: string }
  | { kind: "incoming";   from: string; sessionId: string }
  | { kind: "outgoing";   to: string;   sessionId: string }
  | { kind: "ringing";    to: string;   sessionId: string; earlyMedia: boolean }
  | { kind: "active";     peer: string; sessionId: string; startedAt: number; muted: boolean; held: boolean; direction: "incoming" | "outgoing" }
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
const DEBUG_STORAGE_KEY = "toolkit:jssip-debug";
const DEBUG_NAMESPACES = "JsSIP:*";
const OUTGOING_RINGBACK_FALLBACK_DELAY_MS = 1200;
const ATTENDED_TRANSFER_CODE_STORAGE_KEY = "toolkit:softphone:attended-transfer-code";
const JOIN_CODE_STORAGE_KEY = "toolkit:softphone:join-code";
const DEFAULT_ATTENDED_TRANSFER_CODE = "*2";
const DEFAULT_JOIN_CODE = "*3";

function configureJsSipDebug() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("jssip_debug");
  if (requested === "1" || requested === "true") {
    localStorage.setItem(DEBUG_STORAGE_KEY, "1");
  } else if (requested === "0" || requested === "false") {
    localStorage.removeItem(DEBUG_STORAGE_KEY);
  }

  const enabled = localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  const debugApi = (JsSIP as unknown as {
    debug?: { enable: (namespaces: string) => void; disable: () => void };
  }).debug;
  if (!debugApi) return;
  if (enabled) {
    debugApi.enable(DEBUG_NAMESPACES);
    console.info(`[softphone] JsSIP browser console logging enabled (${DEBUG_NAMESPACES})`);
  } else {
    debugApi.disable();
  }
}

function softphoneDebugEnabled(): boolean {
  return localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
}

function softphoneLog(message: string, data?: unknown) {
  if (!softphoneDebugEnabled()) return;
  if (data === undefined) console.info(`[softphone] ${message}`);
  else console.info(`[softphone] ${message}`, data);
}

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
  const cfgRef = useRef<SoftphoneConfig | null>(null);
  const registeredRef = useRef(false);
  const directionRef = useRef<"incoming" | "outgoing" | null>(null);
  const hasRemoteAudioRef = useRef(false);
  const activatedRef = useRef(false);
  const answeredBeepPlayedRef = useRef(false);
  const ringbackFallbackTimerRef = useRef<number | null>(null);

  const startLocalRingbackFallback = (s: RTCSession, peer: string, reason: string) => {
    if (sessionRef.current !== s || directionRef.current !== "outgoing" || activatedRef.current || hasRemoteAudioRef.current) {
      return;
    }
    startOutgoingRingback();
    softphoneLog(reason, { sessionId: s.id });
    setState({ kind: "ringing", to: peer, sessionId: s.id, earlyMedia: false });
  };

  // Создаём <audio> для remote-стрима один раз.
  useEffect(() => {
    const a = document.createElement("audio");
    a.autoplay = true;
    a.setAttribute("playsinline", "true");
    a.style.display = "none";
    document.body.appendChild(a);
    audioRef.current = a;
    return () => { a.remove(); };
  }, []);

  const teardownSession = () => {
    if (ringbackFallbackTimerRef.current !== null) {
      window.clearTimeout(ringbackFallbackTimerRef.current);
      ringbackFallbackTimerRef.current = null;
    }
    stopOutgoingRingback();
    sessionRef.current = null;
    directionRef.current = null;
    hasRemoteAudioRef.current = false;
    activatedRef.current = false;
    answeredBeepPlayedRef.current = false;
    if (audioRef.current) audioRef.current.srcObject = null;
  };

  const scheduleOutgoingRingbackFallback = (s: RTCSession, peer: string) => {
    if (ringbackFallbackTimerRef.current !== null) {
      window.clearTimeout(ringbackFallbackTimerRef.current);
    }
    ringbackFallbackTimerRef.current = window.setTimeout(() => {
      ringbackFallbackTimerRef.current = null;
      startLocalRingbackFallback(s, peer, "ringback fallback start");
    }, OUTGOING_RINGBACK_FALLBACK_DELAY_MS);
  };

  const attachRemoteAudio = (stream: MediaStream, s: RTCSession, reason: string): boolean => {
    const hasAudio = stream.getAudioTracks().some((track) => track.readyState !== "ended");
    if (!audioRef.current || !hasAudio) return false;

    const isOutgoingBeforeAnswer = directionRef.current === "outgoing" && !activatedRef.current;
    if (!isOutgoingBeforeAnswer) {
      hasRemoteAudioRef.current = true;
    }
    if (!isOutgoingBeforeAnswer && ringbackFallbackTimerRef.current !== null) {
      window.clearTimeout(ringbackFallbackTimerRef.current);
      ringbackFallbackTimerRef.current = null;
    }
    if (directionRef.current === "outgoing" && !isOutgoingBeforeAnswer) {
      stopOutgoingRingback();
      softphoneLog("ringback stop", { reason, sessionId: s.id });
    }

    softphoneLog("remote audio attached", {
      reason,
      sessionId: s.id,
      streamId: stream.id,
      tracks: stream.getTracks().map((track) => ({
        id: track.id,
        kind: track.kind,
        muted: track.muted,
        readyState: track.readyState,
      })),
    });

    audioRef.current.srcObject = stream;
    audioRef.current.muted = false;
    audioRef.current.volume = 1;
    void audioRef.current.play().catch((e: unknown) => softphoneLog("remote audio play failed", e));
    return true;
  };

  const attachRemoteAudioFromReceivers = (s: RTCSession, reason: string): boolean => {
    const pc = s.connection as RTCPeerConnection | undefined;
    if (!pc) return false;
    const tracks = pc.getReceivers()
      .map((receiver) => receiver.track)
      .filter((track): track is MediaStreamTrack => !!track && track.kind === "audio" && track.readyState !== "ended");
    if (tracks.length === 0) return false;
    return attachRemoteAudio(new MediaStream(tracks), s, reason);
  };

  const start = (cfg: SoftphoneConfig) => {
    configureJsSipDebug();
    if (uaRef.current) {
      try { uaRef.current.stop(); } catch { /* noop */ }
      uaRef.current = null;
    }
    cfgRef.current = cfg;
    registeredRef.current = false;
    teardownSession();
    setState({ kind: "connecting" });
    softphoneLog("start", { wssUrl: cfg.wssUrl, extension: cfg.extension, domain: cfg.domain || hostFromWss(cfg.wssUrl) });
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

    ua.on("registered", () => {
      softphoneLog("registered");
      registeredRef.current = true;
      if (!sessionRef.current) setState({ kind: "registered" });
    });
    ua.on("unregistered", () => {
      softphoneLog("unregistered");
      registeredRef.current = false;
      stopOutgoingRingback();
      setState({ kind: "registration_failed", cause: "unregistered" });
    });
    ua.on("registrationFailed", (e: { cause?: string }) => {
      softphoneLog("registrationFailed", e);
      registeredRef.current = false;
      stopOutgoingRingback();
      setState({ kind: "registration_failed", cause: e.cause || "unknown" });
    });

    ua.on("newRTCSession", (data: { session: RTCSession; originator: string }) => {
      const s = data.session;
      sessionRef.current = s;
      hasRemoteAudioRef.current = false;
      activatedRef.current = false;
      answeredBeepPlayedRef.current = false;

      const peer = (s.remote_identity?.uri?.user as string | undefined)
        || (s.remote_identity?.display_name as string | undefined)
        || "unknown";
      const direction: "incoming" | "outgoing" = data.originator === "remote" ? "incoming" : "outgoing";
      directionRef.current = direction;

      softphoneLog("newRTCSession", { originator: data.originator, sessionId: s.id, peer });

      if (direction === "incoming") {
        setState({ kind: "incoming", from: peer, sessionId: s.id });
        callbacks?.onIncoming?.(peer);
      } else {
        setState({ kind: "outgoing", to: peer, sessionId: s.id });
        scheduleOutgoingRingbackFallback(s, peer);
      }

      const activate = (eventName: "accepted" | "confirmed") => {
        if (activatedRef.current) return;
        activatedRef.current = true;
        attachRemoteAudioFromReceivers(s, eventName);
        stopOutgoingRingback();
        if (direction === "outgoing" && !answeredBeepPlayedRef.current) {
          answeredBeepPlayedRef.current = true;
          playAnsweredBeep();
          softphoneLog("answered beep", { sessionId: s.id });
        }
        softphoneLog(`session ${eventName}`, { sessionId: s.id, peer });
        setState({
          kind: "active", peer,
          sessionId: s.id, startedAt: Date.now(),
          muted: false, held: false, direction,
        });
      };

      s.on("progress", (e: unknown) => {
        softphoneLog("session progress", e);
        if (direction === "outgoing" && !activatedRef.current) {
          const statusCode = sipStatusCode(e);
          const hasEarlyMedia = statusCode === 183;
          if (hasEarlyMedia) {
            const attached = attachRemoteAudioFromReceivers(s, "early_media_183");
            if (attached) {
              hasRemoteAudioRef.current = true;
              stopOutgoingRingback();
              softphoneLog("ringback stop", { reason: "early_media_183", sessionId: s.id });
            }
          }
          if (!hasRemoteAudioRef.current) {
            startOutgoingRingback();
            softphoneLog("ringback start", { sessionId: s.id });
          }
          setState({ kind: "ringing", to: peer, sessionId: s.id, earlyMedia: hasRemoteAudioRef.current });
        }
      });
      s.on("accepted", () => activate("accepted"));
      s.on("confirmed", () => activate("confirmed"));
      s.on("ended", () => {
        softphoneLog("session ended", { sessionId: s.id });
        teardownSession();
        setState({ kind: "ended", reason: "ended" });
        // через 2 секунды возвращаем в "registered"
        setTimeout(() => { if (registeredRef.current) setState({ kind: "registered" }); }, 2000);
      });
      s.on("failed", (ev: { cause?: string }) => {
        softphoneLog("session failed", ev);
        teardownSession();
        setState({ kind: "ended", reason: ev.cause || "failed" });
        setTimeout(() => { if (registeredRef.current) setState({ kind: "registered" }); }, 2000);
      });
      s.on("getusermediafailed", (e: unknown) => {
        softphoneLog("getUserMedia failed", e);
        callbacks?.onError?.("Браузер не выдал доступ к микрофону");
      });
      s.on("peerconnection:createofferfailed", (e: unknown) => softphoneLog("peerconnection:createofferfailed", e));
      s.on("peerconnection:createanswerfailed", (e: unknown) => softphoneLog("peerconnection:createanswerfailed", e));
      s.on("peerconnection:setlocaldescriptionfailed", (e: unknown) => softphoneLog("peerconnection:setlocaldescriptionfailed", e));
      s.on("peerconnection:setremotedescriptionfailed", (e: unknown) => softphoneLog("peerconnection:setremotedescriptionfailed", e));
      s.on("peerconnection", () => {
        softphoneLog("peerconnection", { sessionId: s.id });
        // Привязываем remote-стрим как только peer connection появляется.
        const pc = s.connection as RTCPeerConnection | undefined;
        if (!pc) return;
        pc.addEventListener("connectionstatechange", () => {
          softphoneLog("connectionstatechange", pc.connectionState);
          attachRemoteAudioFromReceivers(s, `connectionstate:${pc.connectionState}`);
        });
        pc.addEventListener("track", (ev) => {
          if (ev.track.kind !== "audio") return;
          const stream = ev.streams[0] ?? new MediaStream([ev.track]);
          softphoneLog("remote track", {
            kind: ev.track.kind,
            streamId: stream.id,
            fromEventStream: Boolean(ev.streams[0]),
            muted: ev.track.muted,
            readyState: ev.track.readyState,
          });
          attachRemoteAudio(stream, s, ev.streams[0] ? "track" : "track_without_stream");
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
    registeredRef.current = false;
    cfgRef.current = null;
    teardownSession();
    setState({ kind: "not_configured" });
  };

  const dial = (to: string) => {
    if (!uaRef.current) {
      softphoneLog("dial ignored: UA is not started", { to });
      return;
    }
    if (!to.trim()) return;
    const target = cfgRef.current ? sipTarget(to.trim(), cfgRef.current) : to.trim();
    softphoneLog("dial", { to, target });
    try {
      uaRef.current.call(target, {
        mediaConstraints: { audio: true, video: false },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
      window.setTimeout(() => {
        const s = sessionRef.current;
        if (!s || directionRef.current !== "outgoing") return;
        const peer = (s.remote_identity?.uri?.user as string | undefined)
          || (s.remote_identity?.display_name as string | undefined)
          || to.trim();
        startLocalRingbackFallback(s, peer, "ringback dial fallback start");
      }, 250);
    } catch (e) {
      callbacks?.onError?.(e instanceof Error ? e.message : String(e));
    }
  };

  const answer = () => {
    if (!sessionRef.current) {
      softphoneLog("answer ignored: no current session");
      return;
    }
    softphoneLog("answer", { sessionId: sessionRef.current.id });
    try { sessionRef.current.answer({ mediaConstraints: { audio: true, video: false } }); }
    catch (e) { callbacks?.onError?.(e instanceof Error ? e.message : String(e)); }
  };

  const hangup = () => {
    if (!sessionRef.current) {
      softphoneLog("hangup ignored: no current session");
      return;
    }
    softphoneLog("hangup", { sessionId: sessionRef.current.id });
    stopOutgoingRingback();
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

  const sendDtmf = (digit: string) => {
    const s = sessionRef.current as (RTCSession & { sendDTMF?: (tone: string) => void }) | null;
    if (!s || typeof s.sendDTMF !== "function") return;
    try { s.sendDTMF(digit); }
    catch (e) { callbacks?.onError?.(e instanceof Error ? e.message : String(e)); }
  };

  const sendDtmfSequence = (sequence: string) => {
    const tones = sequence.replace(/\s+/g, "").split("");
    if (tones.length === 0) return;
    tones.forEach((tone, index) => {
      window.setTimeout(() => sendDtmf(tone), index * 140);
    });
  };

  const sendFeatureCodeWithTarget = (code: string, target?: string) => {
    sendDtmfSequence(code);
    const number = target?.trim();
    if (!number) return;
    window.setTimeout(() => sendDtmfSequence(`${number}#`), Math.max(700, code.length * 160));
  };

  const transfer = (to: string) => {
    const s = sessionRef.current as (RTCSession & { refer?: (target: string) => void }) | null;
    const cfg = cfgRef.current;
    const number = to.trim();
    if (!s || !cfg || !number) return;
    if (typeof s.refer !== "function") {
      callbacks?.onError?.("SIP REFER недоступен в текущей сессии");
      return;
    }
    try {
      s.refer(sipTarget(number, cfg));
    } catch (e) {
      callbacks?.onError?.(e instanceof Error ? e.message : String(e));
    }
  };

  const attendedTransfer = (to: string) => {
    const number = to.trim();
    if (!number) return;
    sendFeatureCodeWithTarget(softphoneFeatureCode(ATTENDED_TRANSFER_CODE_STORAGE_KEY, DEFAULT_ATTENDED_TRANSFER_CODE), number);
  };

  const join = (number?: string) => {
    const target = number?.trim() ?? "";
    sendFeatureCodeWithTarget(softphoneFeatureCode(JOIN_CODE_STORAGE_KEY, DEFAULT_JOIN_CODE), target);
  };

  // Cleanup при размонтировании
  useEffect(() => () => { stop(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return { state, start, stop, dial, answer, hangup, toggleMute, toggleHold, sendDtmf, transfer, attendedTransfer, join };
}

function hostFromWss(wss: string): string {
  try {
    const u = new URL(wss);
    return u.hostname;
  } catch {
    return wss.replace(/^wss?:\/\//, "").split("/")[0]!.split(":")[0]!;
  }
}

function sipTarget(to: string, cfg: SoftphoneConfig): string {
  if (/^sip:/i.test(to)) return to;
  const domain = cfg.domain || hostFromWss(cfg.wssUrl);
  return `sip:${to}@${domain}`;
}

function softphoneFeatureCode(storageKey: string, fallback: string): string {
  return localStorage.getItem(storageKey)?.trim() || fallback;
}

function sipStatusCode(event: unknown): number | null {
  const response = (event as { response?: { status_code?: unknown; statusCode?: unknown } } | null)?.response;
  const raw = response?.status_code ?? response?.statusCode;
  return typeof raw === "number" ? raw : null;
}
