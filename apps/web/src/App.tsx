import { Routes, Route, Navigate } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { LoginPage } from "@/auth/Login";
import { Loading } from "@/components/states";

import { AppLayout } from "@/layouts/AppLayout";
import { PhonePage } from "@/modules/phone/PhonePage";
import { MeetPage } from "@/modules/meet/MeetPage";
import { TranscriptsPage } from "@/modules/transcripts/TranscriptsPage";
import { AdminPage } from "@/modules/admin/AdminPage";
import {
  MessengersStub, ContactsStub, HelpdeskStub,
} from "@/modules/stubs";

export function App() {
  const { state } = useAuth();

  if (state.status === "loading") return <Loading label="Восстанавливаем сессию…" />;

  if (state.status === "anonymous") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to="/phone" replace />} />
        <Route path="phone"        element={<PhonePage />} />
        <Route path="meet"         element={<MeetPage />} />
        <Route path="transcripts"  element={<TranscriptsPage />} />
        <Route path="messengers"   element={<MessengersStub />} />
        <Route path="contacts"     element={<ContactsStub />} />
        <Route path="helpdesk"     element={<HelpdeskStub />} />
        <Route path="admin/*"      element={<AdminPage />} />
        <Route path="*"            element={<Navigate to="/phone" replace />} />
      </Route>
    </Routes>
  );
}
