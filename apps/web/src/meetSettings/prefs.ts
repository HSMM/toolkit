// Локальные настройки видеоконференций (per-browser, не синхронизируются
// между устройствами). Хранятся в localStorage; читаются виджетом настроек
// (MeetingSettingsModal) и MeetingRoom при подключении к комнате.
//
// На сервер не уходят: для MVP достаточно локальной памяти. Если в будущем
// понадобится синхронизация между устройствами, поверх этого можно положить
// PUT/GET к /api/v1/system-settings/meet-prefs/me.

import { useEffect, useState } from "react";

const STORAGE_KEY = "toolkit:meet-prefs";

export type MeetBackground =
  | { kind: "none" }
  | { kind: "blur" }
  | { kind: "image"; src: string }; // src — URL или data:URL для кастомной загрузки

export type MeetPrefs = {
  /** Предпочитаемый микрофон (deviceId из MediaDevices). Пусто = «по умолчанию». */
  audioDeviceId: string;
  /** Предпочитаемые динамики (deviceId). Пусто = «по умолчанию». */
  speakerDeviceId: string;
  /** Предпочитаемая камера (deviceId). Пусто = «по умолчанию». */
  videoDeviceId: string;
  /** Подключаться к встрече с выключенным микрофоном. */
  joinMuted: boolean;
  /** Подключаться к встрече с выключенной камерой. */
  joinVideoOff: boolean;
  /** Шумоподавление (обрабатывается браузером, audio constraint). */
  noiseSuppression: boolean;
  /** Видеть себя на встрече (плитка собственного видео в гриде). */
  selfView: boolean;
  /** Скрыть видео остальных участников (экономия трафика). */
  hideOthersVideo: boolean;
  /** Виртуальный фон. */
  background: MeetBackground;
};

export const defaultPrefs: MeetPrefs = {
  audioDeviceId: "",
  speakerDeviceId: "",
  videoDeviceId: "",
  joinMuted: false,
  joinVideoOff: false,
  noiseSuppression: true,
  selfView: true,
  hideOthersVideo: false,
  background: { kind: "none" },
};

/** Читает prefs из localStorage. Битый/отсутствующий → defaults. */
export function loadPrefs(): MeetPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultPrefs };
    const parsed = JSON.parse(raw) as Partial<MeetPrefs>;
    // Сливаем с defaults, чтобы новые поля автоматически появлялись у
    // пользователей, которые сохраняли prefs до их добавления.
    return {
      ...defaultPrefs,
      ...parsed,
      background: validBackground(parsed.background),
    };
  } catch {
    return { ...defaultPrefs };
  }
}

function validBackground(bg: MeetBackground | undefined): MeetBackground {
  if (!bg || typeof bg !== "object") return { kind: "none" };
  if (bg.kind === "none" || bg.kind === "blur") return bg;
  if (bg.kind === "image" && typeof bg.src === "string" && bg.src.length > 0) return bg;
  return { kind: "none" };
}

export function savePrefs(p: MeetPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    // Простой механизм cross-tab синхронизации: storage-event срабатывает
    // в других вкладках. Дополнительно дёрнем "ручное" событие в текущей,
    // чтобы наши хуки тоже среагировали без перезагрузки.
    window.dispatchEvent(new CustomEvent(LOCAL_CHANGE_EVENT));
  } catch {
    // localStorage может быть отключён в режиме инкогнито в некоторых
    // браузерах — в таком случае настройки живут только в памяти процесса.
  }
}

const LOCAL_CHANGE_EVENT = "toolkit:meet-prefs-changed";

/**
 * Реактивный хук над localStorage. Возвращает [prefs, patch].
 * patch принимает Partial<MeetPrefs> и сразу пишет в localStorage.
 */
export function usePrefs(): [MeetPrefs, (patch: Partial<MeetPrefs>) => void] {
  const [prefs, setPrefs] = useState<MeetPrefs>(() => loadPrefs());

  useEffect(() => {
    const reload = () => setPrefs(loadPrefs());
    window.addEventListener("storage", reload);
    window.addEventListener(LOCAL_CHANGE_EVENT, reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener(LOCAL_CHANGE_EVENT, reload);
    };
  }, []);

  const patch = (p: Partial<MeetPrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });
  };

  return [prefs, patch];
}

// ──────────────────────────────────────────────────────────────────────────
// Backgrounds (пресеты + helpers)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Пресет-фоны без сетевых картинок (закрытый контур): хранятся как описание
 * градиента, на лету рендерятся в JPEG-data-URL для VirtualBackground'а.
 */
export const BACKGROUND_PRESETS: { id: string; gradient: string }[] = [
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

/**
 * Конвертирует preset.id (или строку src=`gradient:<id>`) в JPEG data-URL.
 * Используется VirtualBackground'ом — ему нужен реальный URL картинки, а не CSS.
 */
export function gradientToDataURL(idOrSrc: string, w = 1280, h = 720): string {
  const id = idOrSrc.startsWith("gradient:") ? idOrSrc.slice("gradient:".length) : idOrSrc;
  const preset = BACKGROUND_PRESETS.find((p) => p.id === id);
  if (!preset) return "";
  const colors = preset.gradient.match(/#[0-9a-f]{6}/gi);
  if (!colors || colors.length < 2) return "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    // 135deg = top-left → bottom-right.
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, colors[0]!);
    grad.addColorStop(1, colors[1]!);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return "";
  }
}

/** Резолвер любого MeetBackground.image src → реальный URL картинки. */
export function resolveBackgroundImageUrl(src: string): string {
  if (!src) return "";
  if (src.startsWith("data:")) return src;
  if (src.startsWith("gradient:")) return gradientToDataURL(src);
  return src;
}
