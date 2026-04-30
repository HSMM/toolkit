import { useEffect, useState } from "react";
import { Header } from "./Header";
import { PhoneFrame } from "./PhoneFrame";
import { TabsNav } from "./TabsNav";
import { ContactSheet } from "./dialogs/ContactSheet";
import { DynamicIsland } from "./DynamicIsland";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { ActiveCallScreen } from "./screens/ActiveCallScreen";
import { ContactsScreen } from "./screens/ContactsScreen";
import { DialerScreen } from "./screens/DialerScreen";
import { IncomingCallScreen } from "./screens/IncomingCallScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { OutgoingCallScreen } from "./screens/OutgoingCallScreen";
import { RecentsScreen } from "./screens/RecentsScreen";
import { playDtmfTone, startRingtone, stopRingtone, unlockSoftphoneAudio } from "./audio";
import type { Contact, SoftphoneProps, SoftphoneTab } from "./types";
import { requestSoftphoneNotificationPermission } from "@/softphone/notifications";
import "./softphone.css";

export function Softphone(props: SoftphoneProps) {
  const [tab, setTab] = useState<SoftphoneTab>("dialer");
  const [number, setNumber] = useState("");
  const [recentQuery, setRecentQuery] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sheetContact, setSheetContact] = useState<Contact | null | undefined>(undefined);
  const [callOverlayOpen, setCallOverlayOpen] = useState(false);
  const elapsedMs = useElapsed(props.call.kind === "active" ? props.call.startedAt : null);

  useEffect(() => {
    if (props.call.kind === "incoming" || props.call.kind === "dialing" || props.call.kind === "active") setCallOverlayOpen(true);
    if (props.call.kind === "idle" || props.call.kind === "ended") setCallOverlayOpen(false);
  }, [props.call.kind]);

  useEffect(() => {
    if (props.call.kind === "incoming") startRingtone();
    else stopRingtone();
    return stopRingtone;
  }, [props.call.kind]);

  useEffect(() => {
    const unlock = () => {
      unlockSoftphoneAudio();
      void requestSoftphoneNotificationPermission();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSheetContact(undefined);
        if (props.call.kind === "active") setCallOverlayOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.call.kind]);

  return (
    <div className="sp-root light">
      <PhoneFrame>
        {props.isAuthenticated && !callOverlayOpen && props.call.kind === "active" && (
          <div className="sp-island-wrap">
            <DynamicIsland
              registration={props.registration}
              call={props.call}
              elapsedMs={elapsedMs}
              onOpenCall={() => setCallOverlayOpen(true)}
              onAnswer={props.onAnswer}
              onReject={props.onReject}
            />
          </div>
        )}
        <div className="sp-content">
          <Header
            registration={props.registration}
            userNumber={props.userNumber}
            onSettings={() => setSettingsOpen(true)}
            onLogout={props.onLogout}
          />
          {props.isAuthenticated ? (
            <>
              <main className="sp-main">
                {tab === "dialer" && <DialerScreen number={number} setNumber={setNumber} registration={props.registration} call={props.call} onDial={props.onDial} />}
                {tab === "recents" && (
                  <RecentsScreen
                    history={props.history}
                    query={recentQuery}
                    onQuery={setRecentQuery}
                    onDial={props.onDial}
                    onDelete={props.onHistoryDelete}
                    onClear={props.onHistoryClear}
                  />
                )}
                {tab === "contacts" && (
                  <ContactsScreen
                    contacts={props.contacts}
                    query={contactQuery}
                    onQuery={setContactQuery}
                    onDial={props.onDial}
                    onOpen={(contact) => setSheetContact(contact)}
                  />
                )}
              </main>
              <TabsNav value={tab} onChange={setTab} />
            </>
          ) : (
            <LoginScreen onLogin={props.onLogin} />
          )}
        </div>

        {callOverlayOpen && props.call.kind === "incoming" && (
          <IncomingCallScreen call={props.call} onAnswer={props.onAnswer} onReject={props.onReject} />
        )}
        {callOverlayOpen && props.call.kind === "dialing" && (
          <OutgoingCallScreen call={props.call} onHangup={props.onHangup} />
        )}
        {callOverlayOpen && props.call.kind === "active" && (
          <ActiveCallScreen
            call={props.call}
            elapsedMs={elapsedMs}
            onHangup={props.onHangup}
            onToggleMute={props.onToggleMute}
            onToggleHold={props.onToggleHold}
            onToggleSpeaker={props.onToggleSpeaker}
            onHome={() => setCallOverlayOpen(false)}
            onTransfer={props.onTransfer}
            onAttendedTransfer={props.onAttendedTransfer}
            onJoin={props.onJoin}
            onSendDtmf={(digit) => {
              playDtmfTone(digit);
              props.onSendDtmf(digit);
            }}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            audioDevices={props.audioDevices}
            selectedDevices={props.selectedDevices}
            onDeviceChange={props.onDeviceChange}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {sheetContact !== undefined && (
          <ContactSheet
            contact={sheetContact}
            onClose={() => setSheetContact(undefined)}
            onDial={props.onDial}
            onCreate={props.onContactCreate}
            onUpdate={props.onContactUpdate}
            onDelete={props.onContactDelete}
          />
        )}
      </PhoneFrame>
    </div>
  );
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === null) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : now - startedAt;
}
