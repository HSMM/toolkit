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
