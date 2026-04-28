// Настройки видеоконференций (вызываются по шестерёнке в шапке VcsPage).
// Layout: модалка светлой темы Toolkit (как остальные настройки), слева
// сайдбар-табы, справа содержимое таба.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon, Mic, Video as VideoIcon, X, Plus, Ban, Play,
} from "lucide-react";
import { C } from "@/styles/tokens";
import { usePrefs, type MeetPrefs, type MeetBackground } from "./prefs";

type Tab = "background" | "sound" | "video";

export function MeetingSettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("sound");

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 250,
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 96vw)", height: "min(620px, 92vh)",
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
          display: "flex", overflow: "hidden", color: C.text,
        }}>

        {/* Sidebar */}
        <div style={{
          width: 230, padding: 14, borderRight: `1px solid ${C.border}`,
          display: "flex", flexDirection: "column", flexShrink: 0, background: C.bg2,
        }}>
          <SidebarItem active={tab === "background"} icon={<ImageIcon size={16} />}
            label="Фон на встрече" onClick={() => setTab("background")} />
          <SidebarItem active={tab === "sound"}      icon={<Mic size={16} />}
            label="Звук" onClick={() => setTab("sound")} />
          <SidebarItem active={tab === "video"}      icon={<VideoIcon size={16} />}
            label="Видео" onClick={() => setTab("video")} />
          <div style={{ flex: 1 }} />
        </div>

        {/* Right: header + content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between",
                        alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
              {tab === "background" ? "Фон на встрече" : tab === "sound" ? "Звук" : "Видео"}
            </div>
            <button onClick={onClose}
              style={{ width: 30, height: 30, borderRadius: 7, background: "transparent",
                       color: C.text2, border: "none", cursor: "pointer",
                       display: "flex", alignItems: "center", justifyContent: "center" }}>
              <X size={18} />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 22, background: C.card }}>
            {tab === "background" && <BackgroundTab />}
            {tab === "sound"      && <SoundTab />}
            {tab === "video"      && <VideoTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({ active, icon, label, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        marginBottom: 2, borderRadius: 8,
        border: `1px solid ${active ? C.border : "transparent"}`,
        background: active ? C.card : "transparent",
        color: active ? C.text : C.text2,
        fontSize: 13.5, fontWeight: active ? 600 : 500,
        cursor: "pointer", fontFamily: "inherit", textAlign: "left",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.04)" : "none",
      }}>
      {icon}{label}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SOUND TAB
// ──────────────────────────────────────────────────────────────────────────

function SoundTab() {
  const [prefs, patch] = usePrefs();
  const audioDevices = useDevices("audioinput");
  const speakerDevices = useDevices("audiooutput");
  const meterStreamRef = useRef<MediaStream | null>(null);
  const [meterLevel, setMeterLevel] = useState(0); // 0..1

  // Открываем поток с выбранного микрофона для VU-meter'а.
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let stream: MediaStream | null = null;
    let buf: Uint8Array<ArrayBuffer> | null = null;
    let started = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: prefs.audioDeviceId
            ? { deviceId: { exact: prefs.audioDeviceId } }
            : true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        meterStreamRef.current = stream;
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctor!();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        started = true;
        const tick = () => {
          if (cancelled || !analyser || !buf) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setMeterLevel(Math.min(1, rms * 3));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setMeterLevel(0);
      }
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (started) { try { ctx?.close(); } catch { /* noop */ } }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      meterStreamRef.current = null;
    };
  }, [prefs.audioDeviceId]);

  const testMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: prefs.audioDeviceId ? { deviceId: { exact: prefs.audioDeviceId } } : true,
      });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        await playOnSpeaker(audio, prefs.speakerDeviceId);
      };
      rec.start();
      setTimeout(() => rec.stop(), 3000);
    } catch (e) {
      alert("Не удалось проверить микрофон: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const testSpeaker = async () => {
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor!();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 660;
      o.type = "sine";
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      setTimeout(() => { o.stop(); ctx.close(); }, 700);
    } catch (e) {
      alert("Не удалось воспроизвести тон: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card title="Микрофон" levelMeter={meterLevel}>
        <DeviceSelect devices={audioDevices.list} value={prefs.audioDeviceId}
          onChange={(v) => patch({ audioDeviceId: v })}
          fallback="По умолчанию" />
        <SecondaryButton onClick={testMic} icon={<Play size={13} />} label="Проверить" />
      </Card>

      <Toggle label="Подключаться с выключенным микрофоном"
        value={prefs.joinMuted} onChange={(v) => patch({ joinMuted: v })} />

      <Card title="Динамик" levelMeter={null}>
        <DeviceSelect devices={speakerDevices.list} value={prefs.speakerDeviceId}
          onChange={(v) => patch({ speakerDeviceId: v })}
          fallback="По умолчанию" />
        <SecondaryButton onClick={testSpeaker} icon={<Play size={13} />} label="Проверить" />
      </Card>

      <Card title="Дополнительно" levelMeter={null}>
        <Toggle label="Шумоподавление"
          value={prefs.noiseSuppression}
          onChange={(v) => patch({ noiseSuppression: v })} inline />
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// VIDEO TAB
// ──────────────────────────────────────────────────────────────────────────

function VideoTab() {
  const [prefs, patch] = usePrefs();
  const cameras = useDevices("videoinput");
  const videoEl = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: prefs.videoDeviceId
            ? { deviceId: { exact: prefs.videoDeviceId } }
            : true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (videoEl.current) videoEl.current.srcObject = stream;
      } catch { /* нет камеры или отказ */ }
    })();
    return () => {
      cancelled = true;
      if (videoEl.current) videoEl.current.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [prefs.videoDeviceId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Превью камеры — оставляем тёмным фоном, как любое видео-окно. */}
      <div style={{ background: "#1a1a1d", border: `1px solid ${C.border}`, borderRadius: 10, aspectRatio: "16 / 9", overflow: "hidden", position: "relative" }}>
        <video ref={videoEl} autoPlay playsInline muted
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
        {cameras.list.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>
            Камеры не найдены
          </div>
        )}
      </div>

      <div>
        <Lbl>Камера</Lbl>
        <DeviceSelect devices={cameras.list} value={prefs.videoDeviceId}
          onChange={(v) => patch({ videoDeviceId: v })} fallback="По умолчанию" full />
      </div>

      <Toggle label="Подключаться с выключенной камерой"
        value={prefs.joinVideoOff} onChange={(v) => patch({ joinVideoOff: v })} />

      <Toggle label="Видеть себя на встрече"
        value={prefs.selfView} onChange={(v) => patch({ selfView: v })} />

      <Toggle label="Скрыть видео участников" sub="Снизит нагрузку на сеть"
        value={prefs.hideOthersVideo} onChange={(v) => patch({ hideOthersVideo: v })} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// BACKGROUND TAB
// ──────────────────────────────────────────────────────────────────────────

const BACKGROUND_PRESETS: { id: string; gradient: string }[] = [
  { id: "office",   gradient: "linear-gradient(135deg,#5b8aa9 0%,#cdd6df 100%)" },
  { id: "warm",     gradient: "linear-gradient(135deg,#c79762 0%,#f6e3c5 100%)" },
  { id: "forest",   gradient: "linear-gradient(135deg,#3a6b56 0%,#a8c8a0 100%)" },
  { id: "yellow",   gradient: "linear-gradient(135deg,#c5a13b 0%,#fff1bc 100%)" },
  { id: "wood",     gradient: "linear-gradient(135deg,#7a4d2c 0%,#d8b48a 100%)" },
  { id: "sky",      gradient: "linear-gradient(135deg,#5fa8d3 0%,#e0f3ff 100%)" },
  { id: "rose",     gradient: "linear-gradient(135deg,#b8556e 0%,#f6c4ce 100%)" },
  { id: "graphite", gradient: "linear-gradient(135deg,#2d3138 0%,#727680 100%)" },
  { id: "lavender", gradient: "linear-gradient(135deg,#6e5d9e 0%,#dbd0ee 100%)" },
  { id: "teal",     gradient: "linear-gradient(135deg,#2f7d7d 0%,#bce4e4 100%)" },
  { id: "sand",     gradient: "linear-gradient(135deg,#a48259 0%,#ecdcc1 100%)" },
  { id: "night",    gradient: "linear-gradient(135deg,#1a233a 0%,#5a6b8a 100%)" },
];

function BackgroundTab() {
  const [prefs, patch] = usePrefs();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const isSelected = (bg: MeetBackground): boolean => {
    if (bg.kind !== prefs.background.kind) return false;
    if (bg.kind === "image" && prefs.background.kind === "image") {
      return bg.src === prefs.background.src;
    }
    return true;
  };

  const onFile = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      alert("Только изображения (JPG/PNG/WebP).");
      return;
    }
    if (f.size > 4 * 1024 * 1024) {
      alert("Файл больше 4 МБ — выберите меньше или используйте размытие.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      if (src) patch({ background: { kind: "image", src } });
    };
    reader.readAsDataURL(f);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.5 }}>
        Виртуальный фон применяется к вашему видео в комнате. Реальное наложение появится в следующей версии — сейчас выбор сохраняется и будет применён, когда включим сегментацию.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
        <PresetTile selected={isSelected({ kind: "none" })}
          onClick={() => patch({ background: { kind: "none" } })}
          content={
            <div style={{ width: "100%", height: "100%", display: "flex",
                          alignItems: "center", justifyContent: "center", color: C.text3, background: C.bg3 }}>
              <Ban size={20} />
            </div>}
          label="Нет фона" />

        <PresetTile selected={prefs.background.kind === "image" && prefs.background.src.startsWith("data:")}
          onClick={() => fileInput.current?.click()}
          content={
            <div style={{ width: "100%", height: "100%", display: "flex",
                          alignItems: "center", justifyContent: "center", color: C.text3, background: C.bg3 }}>
              <Plus size={22} />
            </div>}
          label="Свой" />

        <PresetTile selected={isSelected({ kind: "blur" })}
          onClick={() => patch({ background: { kind: "blur" } })}
          content={<div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg,#1f2933 0%,#3a4554 100%)", filter: "blur(0.5px)" }} />}
          label="Размытие" />

        {BACKGROUND_PRESETS.map((p) => {
          const src = `gradient:${p.id}`;
          const sel = prefs.background.kind === "image" && prefs.background.src === src;
          return (
            <PresetTile key={p.id} selected={sel}
              onClick={() => patch({ background: { kind: "image", src } })}
              content={<div style={{ width: "100%", height: "100%", background: p.gradient }} />}
              label="" />
          );
        })}
      </div>

      <input ref={fileInput} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </div>
  );
}

function PresetTile({ selected, onClick, content, label }: {
  selected: boolean;
  onClick: () => void;
  content: React.ReactNode;
  label: string;
}) {
  return (
    <div>
      <button onClick={onClick}
        style={{
          width: "100%", aspectRatio: "1 / 1", borderRadius: 8,
          border: `2px solid ${selected ? C.acc : C.border}`,
          background: C.card, padding: 0, overflow: "hidden", cursor: "pointer",
          display: "block",
        }}>
        {content}
      </button>
      {label && <div style={{ marginTop: 4, fontSize: 10.5, color: C.text2, textAlign: "center" }}>{label}</div>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SHARED PIECES
// ──────────────────────────────────────────────────────────────────────────

function Card({ title, levelMeter, children }: {
  title: string;
  levelMeter: number | null;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div>
        {levelMeter !== null && <Meter level={levelMeter} />}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Meter({ level }: { level: number }) {
  const segs = 10;
  const filled = Math.round(level * segs);
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {Array.from({ length: segs }, (_, i) => (
        <div key={i} style={{
          width: 6, height: 14, borderRadius: 2,
          background: i < filled
            ? (i >= 7 ? C.err : i >= 5 ? C.warn : C.ok)
            : C.bg3,
        }} />
      ))}
    </div>
  );
}

function DeviceSelect({ devices, value, onChange, fallback, full }: {
  devices: MediaDeviceInfo[]; value: string; onChange: (v: string) => void;
  fallback: string; full?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{
        flex: full ? "1 1 100%" : 1, minWidth: 0,
        padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`,
        background: C.card, color: C.text, fontSize: 13, fontFamily: "inherit",
        outline: "none", cursor: "pointer",
      }}>
      <option value="">{fallback}</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${d.kind} (${d.deviceId.slice(0, 6)}…)`}
        </option>
      ))}
    </select>
  );
}

function SecondaryButton({ onClick, icon, label }: { onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
        background: C.card, color: C.text, fontSize: 12.5, fontWeight: 500,
        cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
      }}>
      {icon} {label}
    </button>
  );
}

function Toggle({ label, sub, value, onChange, inline }: {
  label: string; sub?: string; value: boolean; onChange: (v: boolean) => void; inline?: boolean;
}) {
  const wrap = inline
    ? { padding: 0, border: "none", background: "transparent" }
    : { padding: "12px 14px", border: `1px solid ${C.border}`, borderRadius: 10, background: C.bg2 };
  return (
    <label style={{ ...wrap, display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.text }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: C.text2, marginTop: 2 }}>{sub}</div>}
      </div>
      <Switch on={value} onClick={() => onChange(!value)} />
    </label>
  );
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={(e) => { e.preventDefault(); onClick(); }}
      style={{
        position: "relative", width: 36, height: 20, borderRadius: 10,
        background: on ? C.acc : C.border2, border: "none", cursor: "pointer", flexShrink: 0,
      }}>
      <div style={{
        position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16,
        background: "white", borderRadius: "50%", transition: "left .15s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
      }} />
    </button>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.text2, marginBottom: 6, fontWeight: 500 }}>{children}</div>;
}

// ──────────────────────────────────────────────────────────────────────────
// HOOKS
// ──────────────────────────────────────────────────────────────────────────

function useDevices(kind: MediaDeviceInfo["kind"]) {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        if (kind === "audioinput" || kind === "audiooutput") {
          await navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then((s) => s.getTracks().forEach((t) => t.stop()))
            .catch(() => undefined);
        } else if (kind === "videoinput") {
          await navigator.mediaDevices
            .getUserMedia({ video: true })
            .then((s) => s.getTracks().forEach((t) => t.stop()))
            .catch(() => undefined);
        }
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setList(all.filter((d) => d.kind === kind));
      } catch {
        if (!cancelled) setList([]);
      }
    };
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
    };
  }, [kind]);

  return useMemo(() => ({ list }), [list]);
}

async function playOnSpeaker(audio: HTMLAudioElement, deviceId: string) {
  try {
    type WithSink = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    const a = audio as WithSink;
    if (deviceId && typeof a.setSinkId === "function") {
      await a.setSinkId(deviceId);
    }
  } catch { /* не критично */ }
  try { await audio.play(); } catch { /* user gesture может потребоваться */ }
}

export type { MeetPrefs };
