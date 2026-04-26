// Главный layout: sidebar слева, контент справа.
// Используется для всех authenticated-страниц.

import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useMe } from "@/api/me";
import { Loading, ErrorBox } from "@/components/states";
import { C } from "@/styles/tokens";

export function AppLayout() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.isError)   return <ErrorBox message={String(me.error)} onRetry={() => me.refetch()} />;
  if (!me.data)     return <Loading />;

  const isAdmin = me.data.role === "admin";

  return (
    <div style={{ display: "flex", height: "100vh", background: C.bg2 }}>
      <Sidebar isAdmin={isAdmin} />
      <main style={{ flex: 1, overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
