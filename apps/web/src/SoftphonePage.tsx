import { useEffect, useRef, useState } from "react";
import { Softphone } from "@/components/softphone/Softphone";
import type { AudioDevice, CallDirection, CallState, Contact, RegistrationStatus } from "@/components/softphone/types";
import {
  useClearSoftphoneCallLog,
  useCreateSoftphoneCallLog,
  useDeleteSoftphoneCallLog,
  useSoftphoneCallHistory,
} from "@/api/softphone-calls";
import { useMyPhoneCredentials } from "@/api/system-settings";
import { useSoftphone, type SoftphoneConfig, type SoftphoneState } from "@/softphone/useSoftphone";
import {
  closeIncomingCallNotifications,
  isSoftphoneNotificationMessage,
  notificationBroadcastChannel,
  showIncomingCallNotification,
} from "@/softphone/notifications";

export function SoftphonePage() {
  const creds = useMyPhoneCredentials();
  const phone = useSoftphone();
  const startedKeyRef = useRef("");
  const history = useSoftphoneCallHistory(creds.data?.extension);
  const createCallLog = useCreateSoftphoneCallLog();
  const deleteCallLog = useDeleteSoftphoneCallLog();
  const clearCallLog = useClearSoftphoneCallLog();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [audioDevices, setAudioDevices] = useState<{ microphones: AudioDevice[]; speakers: AudioDevice[]; ringtones: AudioDevice[] }>({
    microphones: [],
    speakers: [],
    ringtones: [],
  });
  const [selectedDevices, setSelectedDevices] = useState<{ microphoneId?: string; speakerId?: string; ringtoneId?: string }>({});
  const prevStateRef = useRef<SoftphoneState>({ kind: "not_configured" });
  const notifiedIncomingRef = useRef<string | null>(null);
  const handledNotificationActionsRef = useRef<Set<string>>(new Set());
  const phoneRef = useRef(phone);

  useEffect(() => {
    phoneRef.current = phone;
  }, [phone]);

  useEffect(() => {
    void refreshAudioDevices().then((devices) => {
      setAudioDevices(devices);
      setSelectedDevices({
        microphoneId: devices.microphones[0]?.deviceId,
        speakerId: devices.speakers[0]?.deviceId,
        ringtoneId: devices.ringtones[0]?.deviceId,
      });
    });
  }, []);

  useEffect(() => {
    if (creds.isLoading) return;
    if (!creds.data?.wss_url || !creds.data.extension) {
      phone.stop();
      startedKeyRef.current = "";
      return;
    }
    const cfg: SoftphoneConfig = {
      wssUrl: creds.data.wss_url,
      extension: creds.data.extension,
      password: creds.data.password,
    };
    const key = `${cfg.wssUrl}|${cfg.extension}|${cfg.password}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    phone.start(cfg);
    // phone object methods are intentionally excluded: start once per credential key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds.data, creds.isLoading]);

  useEffect(() => {
    const prev = prevStateRef.current;
    const cur = phone.state;
    if (cur.kind === "ended" && prev.kind !== "ended") {
      const peer = prev.kind === "incoming" ? prev.from
        : prev.kind === "outgoing" ? prev.to
        : prev.kind === "ringing" ? prev.to
        : prev.kind === "active" ? prev.peer
        : "unknown";
      const direction: CallDirection = prev.kind === "incoming" ? "missed"
        : prev.kind === "active" && prev.direction === "incoming" ? "incoming"
        : "outgoing";
      const durationSec = prev.kind === "active" ? Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000)) : undefined;
      const timestamp = prev.kind === "active" ? new Date(prev.startedAt).toISOString() : new Date().toISOString();
      const sessionId = "sessionId" in prev ? prev.sessionId : crypto.randomUUID();
      createCallLog.mutate({
        session_id: sessionId,
        direction,
        number: peer,
        timestamp,
        duration_sec: durationSec,
        status: direction === "missed" ? "missed" : durationSec !== undefined ? "answered" : reasonToStatus(cur.reason),
        reason: cur.reason,
      });
    }
    prevStateRef.current = cur;
  }, [createCallLog, phone.state]);

  useEffect(() => {
    if (phone.state.kind === "incoming") {
      if (notifiedIncomingRef.current !== phone.state.sessionId) {
        notifiedIncomingRef.current = phone.state.sessionId;
        void showIncomingCallNotification({
          number: phone.state.from,
          callId: phone.state.sessionId,
        });
      }
      return;
    }

    notifiedIncomingRef.current = null;
    handledNotificationActionsRef.current.clear();
    void closeIncomingCallNotifications();
  }, [phone.state]);

  useEffect(() => {
    const handleNotificationAction = (data: unknown) => {
      if (!isSoftphoneNotificationMessage(data)) return;
      const currentPhone = phoneRef.current;
      if (currentPhone.state.kind !== "incoming") return;
      if (data.callId && data.callId !== currentPhone.state.sessionId) return;
      const actionKey = `${data.action}:${data.callId || currentPhone.state.sessionId}`;
      if (handledNotificationActionsRef.current.has(actionKey)) return;
      handledNotificationActionsRef.current.add(actionKey);
      if (data.action === "answer") currentPhone.answer();
      if (data.action === "reject") currentPhone.hangup();
    };
    const onServiceWorkerMessage = (event: MessageEvent) => {
      handleNotificationAction(event.data);
    };

    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);

    const channel = "BroadcastChannel" in window ? new BroadcastChannel(notificationBroadcastChannel()) : null;
    if (channel) {
      channel.onmessage = (event) => handleNotificationAction(event.data);
    }

    return () => {
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
      channel?.close();
    };
  }, []);

  const registration = mapRegistration(phone.state, creds.isLoading);
  const call = mapCall(phone.state);

  return (
    <div className="sp-page">
      <Softphone
        isAuthenticated
        registration={registration}
        userNumber={creds.data?.extension}
        call={call}
        history={history.data ?? []}
        contacts={contacts}
        audioDevices={audioDevices}
        selectedDevices={selectedDevices}
        onLogin={() => undefined}
        onLogout={phone.stop}
        onDial={phone.dial}
        onAnswer={phone.answer}
        onReject={phone.hangup}
        onHangup={phone.hangup}
        onToggleMute={phone.toggleMute}
        onToggleHold={phone.toggleHold}
        onToggleSpeaker={() => undefined}
        onSendDtmf={phone.sendDtmf}
        onTransfer={phone.transfer}
        onAttendedTransfer={phone.attendedTransfer}
        onJoin={phone.join}
        onDeviceChange={(kind, deviceId) => {
          setSelectedDevices((prev) => ({
            ...prev,
            [kind === "microphone" ? "microphoneId" : kind === "speaker" ? "speakerId" : "ringtoneId"]: deviceId,
          }));
        }}
        onContactCreate={(contact) => setContacts((items) => [{ ...contact, id: crypto.randomUUID() }, ...items])}
        onContactUpdate={(contact) => setContacts((items) => items.map((item) => item.id === contact.id ? contact : item))}
        onContactDelete={(id) => setContacts((items) => items.filter((item) => item.id !== id))}
        onHistoryDelete={(id) => deleteCallLog.mutate(id)}
        onHistoryClear={() => clearCallLog.mutate()}
      />
    </div>
  );
}

function reasonToStatus(reason: string): "failed" | "cancelled" | "ended" {
  const normalized = reason.toLowerCase();
  if (normalized.includes("cancel") || normalized.includes("bye")) return "cancelled";
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  return "ended";
}

function mapRegistration(state: SoftphoneState, loading: boolean): RegistrationStatus {
  if (loading || state.kind === "connecting") return "connecting";
  if (state.kind === "registered" || state.kind === "incoming" || state.kind === "outgoing" || state.kind === "ringing" || state.kind === "active" || state.kind === "ended") return "online";
  if (state.kind === "registration_failed") return "error";
  return "offline";
}

function mapCall(state: SoftphoneState): CallState {
  switch (state.kind) {
    case "incoming":
      return { kind: "incoming", from: { number: state.from } };
    case "outgoing":
      return { kind: "dialing", to: { number: state.to }, phase: "connecting" };
    case "ringing":
      return { kind: "dialing", to: { number: state.to }, phase: "ringing", earlyMedia: state.earlyMedia };
    case "active":
      return {
        kind: "active",
        peer: { number: state.peer },
        startedAt: state.startedAt,
        muted: state.muted,
        onHold: state.held,
        speakerOn: false,
      };
    case "ended":
      return { kind: "ended", reason: state.reason };
    default:
      return { kind: "idle" };
  }
}

async function refreshAudioDevices(): Promise<{ microphones: AudioDevice[]; speakers: AudioDevice[]; ringtones: AudioDevice[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], speakers: [], ringtones: [] };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Микрофон ${index + 1}` }));
    const speakers = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Динамик ${index + 1}` }));
    return { microphones, speakers, ringtones: speakers };
  } catch {
    return { microphones: [], speakers: [], ringtones: [] };
  }
}
