export type CallDirection = "incoming" | "outgoing" | "missed";
export type RegistrationStatus = "offline" | "connecting" | "online" | "error";

export type CallState =
  | { kind: "idle" }
  | { kind: "incoming"; from: { name?: string; number: string; avatar?: string } }
  | { kind: "dialing"; to: { name?: string; number: string }; phase?: "connecting" | "ringing"; earlyMedia?: boolean }
  | { kind: "active"; peer: { name?: string; number: string }; startedAt: number; muted: boolean; onHold: boolean; speakerOn: boolean }
  | { kind: "ended"; reason: string };

export type HistoryItem = {
  id: string;
  direction: CallDirection;
  name?: string;
  number: string;
  timestamp: number;
  durationSec?: number;
};

export type Contact = {
  id: string;
  name: string;
  numbers: { type: "work" | "mobile" | "home"; value: string }[];
  department?: string;
  favorite?: boolean;
};

export type AudioDevice = { deviceId: string; label: string };

export type SoftphoneProps = {
  isAuthenticated: boolean;
  registration: RegistrationStatus;
  userNumber?: string;
  call: CallState;
  history: HistoryItem[];
  contacts: Contact[];
  audioDevices: { microphones: AudioDevice[]; speakers: AudioDevice[]; ringtones: AudioDevice[] };
  selectedDevices: { microphoneId?: string; speakerId?: string; ringtoneId?: string };
  onLogin: (credentials: { login: string; password: string; server: string }) => void;
  onLogout: () => void;
  onDial: (number: string) => void;
  onAnswer: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleSpeaker: () => void;
  onSendDtmf: (digit: string) => void;
  onTransfer: (number: string) => void;
  onAttendedTransfer: (number: string) => void;
  onJoin: (number?: string) => void;
  onDeviceChange: (kind: "microphone" | "speaker" | "ringtone", deviceId: string) => void;
  onContactCreate: (contact: Omit<Contact, "id">) => void;
  onContactUpdate: (contact: Contact) => void;
  onContactDelete: (id: string) => void;
  onHistoryDelete: (id: string) => void;
  onHistoryClear: () => void;
};

export type SoftphoneTab = "dialer" | "recents" | "contacts";
