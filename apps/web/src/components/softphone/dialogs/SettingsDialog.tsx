import { useState } from "react";
import type { AudioDevice, SoftphoneProps } from "../types";

type Props = Pick<SoftphoneProps, "audioDevices" | "selectedDevices" | "onDeviceChange"> & { onClose: () => void };

type Tab = "audio";

export function SettingsDialog({ audioDevices, selectedDevices, onDeviceChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("audio");
  return (
    <div className="sp-dialog-backdrop" role="dialog" aria-modal="true" aria-label="Настройки">
      <div className="sp-dialog">
        <div className="sp-contact-head">
          <strong>Настройки</strong>
          <button className="sp-icon-btn" onClick={onClose} aria-label="Закрыть">Esc</button>
        </div>
        <div className="sp-dialog-tabs">
          <DialogTab active={tab === "audio"} onClick={() => setTab("audio")}>Аудио</DialogTab>
        </div>

        {tab === "audio" && (
          <div className="sp-form">
            <DeviceSelect label="Микрофон" devices={audioDevices.microphones} value={selectedDevices.microphoneId} onChange={(v) => onDeviceChange("microphone", v)} />
            <DeviceSelect label="Динамик" devices={audioDevices.speakers} value={selectedDevices.speakerId} onChange={(v) => onDeviceChange("speaker", v)} />
            <DeviceSelect label="Устройство вызова" devices={audioDevices.ringtones} value={selectedDevices.ringtoneId} onChange={(v) => onDeviceChange("ringtone", v)} />
            <span className="sp-sub-text">Изменения применяются при следующем звонке</span>
          </div>
        )}
        <button className="sp-btn" style={{ marginTop: 16 }} onClick={onClose}>Готово</button>
      </div>
    </div>
  );
}

function DialogTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`sp-dialog-tab ${active ? "active" : ""}`} onClick={onClick}>{children}</button>;
}

function DeviceSelect({ label, devices, value, onChange }: { label: string; devices: AudioDevice[]; value?: string; onChange: (deviceId: string) => void }) {
  return (
    <label className="sp-label">{label}
      <select className="sp-select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>Выберите устройство</option>
        {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
      </select>
    </label>
  );
}
