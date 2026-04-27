// GuestPage — публичная landing-страница для входа гостя по ссылке /g/<token>.
// Открывается БЕЗ сессии Toolkit (внешний человек, инкогнито-вкладка и т.п.).
// Шаги:
//   1) GET /api/v1/guests/{token} — узнать название встречи и host'а.
//   2) Гость вводит имя → POST /api/v1/guests/{token}/join → LiveKit креды.
//   3) Открываем MeetingRoom с этими кредами.

import { useEffect, useState } from "react";
import { Loader2, Video, AlertCircle } from "lucide-react";
import "@livekit/components-styles";
import { LiveKitRoom } from "@livekit/components-react";
import { RussianRoomUI } from "@/RoomUI";
import { C } from "@/styles/tokens";
import { api, ApiError } from "@/api/client";

type GuestInfo = {
  meeting_id: string;
  title: string;
  started_at?: string;
  scheduled_at?: string;
  host_name?: string;
};

type JoinResult = {
  token: string;
  ws_url: string;
  room: string;
  identity: string;
  role: string;
};

type GuestStatus = {
  state: "pending" | "admitted" | "rejected" | "ended";
  join?: JoinResult;
};

type Stage =
  | { kind: "form" }                              // вводит имя
  | { kind: "waiting"; requestId: string }        // запрос отправлен, ждём admit
  | { kind: "admitted"; creds: JoinResult }       // в комнате
  | { kind: "rejected" }                          // host отклонил
  | { kind: "ended" };                            // встреча завершилась пока ждали

export function GuestPage({ token }: { token: string }) {
  const [info, setInfo] = useState<GuestInfo | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<GuestInfo>(`/api/v1/guests/${encodeURIComponent(token)}`).then(
      (r) => { if (!cancelled) setInfo(r); },
      (e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404)      setLookupErr("Ссылка недействительна или встреча уже завершена.");
        else if (e instanceof ApiError && e.status === 409) setLookupErr("Встреча уже завершена.");
        else                                                setLookupErr(e instanceof Error ? e.message : "Не удалось загрузить встречу");
      },
    );
    return () => { cancelled = true; };
  }, [token]);

  // Поллим статус заявки пока stage=waiting; останавливаемся как только не pending.
  useEffect(() => {
    if (stage.kind !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const s = await api<GuestStatus>(`/api/v1/guests/${encodeURIComponent(token)}/status/${stage.requestId}`);
        if (cancelled) return;
        if (s.state === "admitted" && s.join)  setStage({ kind: "admitted", creds: s.join });
        else if (s.state === "rejected")        setStage({ kind: "rejected" });
        else if (s.state === "ended")           setStage({ kind: "ended" });
        else { timer = setTimeout(poll, 2000); }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 4000); // мягкий backoff на сетевых ошибках
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [stage, token]);

  const submit = async () => {
    setSubmitting(true); setSubmitErr(null);
    try {
      const r = await api<{ request_id: string }>(`/api/v1/guests/${encodeURIComponent(token)}/request`, {
        method: "POST",
        body: { display_name: name.trim() || "Гость" },
      });
      setStage({ kind: "waiting", requestId: r.request_id });
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── уже в комнате ───
  if (stage.kind === "admitted") {
    const creds = stage.creds;
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0b0b0c", display: "flex", flexDirection: "column" }}>
        <div style={{ flexShrink: 0, padding: "10px 16px", borderBottom: "1px solid #1f1f22", background: "#111114", color: "#e5e7eb" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{info?.title ?? "Встреча"}</div>
          <div style={{ fontSize: 11, color: "#9ca3af" }}>Вы в комнате как гость · {creds.identity}</div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <LiveKitRoom
            token={creds.token}
            serverUrl={creds.ws_url}
            connect
            // см. MeetingRoom.tsx — video/audio пользователь включит сам
            data-lk-theme="default"
            style={{ height: "100%", width: "100%" }}
            onDisconnected={() => { setStage({ kind: "form" }); }}
          >
            <RussianRoomUI />
          </LiveKitRoom>
        </div>
      </div>
    );
  }

  // ─── окончательные состояния ───
  if (lookupErr)             return <CenterCard icon="err"  title="Ссылка недоступна" sub={lookupErr} />;
  if (stage.kind === "rejected") return <CenterCard icon="err" title="Организатор отклонил вход" sub="Свяжитесь с автором встречи и попросите выслать новое приглашение." />;
  if (stage.kind === "ended")    return <CenterCard icon="err" title="Встреча завершена" sub="Вы пытались войти, но организатор уже закрыл встречу." />;
  if (!info)                 return <CenterCard icon="load" title="Загружаем встречу…" />;

  // ─── ожидание подтверждения от host'а ───
  if (stage.kind === "waiting") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, padding: 20, fontFamily: "'Outfit', system-ui, sans-serif" }}>
        <div style={{ width: "100%", maxWidth: 420, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, boxShadow: "0 12px 30px rgba(0,0,0,0.06)", textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: C.accBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
            <Loader2 size={28} color={C.acc} className="lk-spin" />
          </div>
          <h1 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600, color: C.text }}>Ожидаем подтверждения</h1>
          <div style={{ fontSize: 13, color: C.text2, marginBottom: 18, lineHeight: 1.5 }}>
            {info.host_name ? `${info.host_name} получил уведомление и сейчас принимает решение о вашем входе во встречу «${info.title}».` : "Организатор получил уведомление и сейчас принимает решение о вашем входе."}
          </div>
          <div style={{ fontSize: 11.5, color: C.text3, lineHeight: 1.5 }}>
            Не закрывайте эту вкладку — как только вас допустят, вы автоматически попадёте в комнату.
          </div>
          <style>{`.lk-spin{animation:lk-spin 1s linear infinite}@keyframes lk-spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </div>
    );
  }

  // ─── форма ввода имени ───
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, padding: 20, fontFamily: "'Outfit', system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 420, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, boxShadow: "0 12px 30px rgba(0,0,0,0.06)" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: C.accBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
          <Video size={26} color={C.acc} />
        </div>
        <h1 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 600, color: C.text, textAlign: "center" }}>{info.title}</h1>
        <div style={{ fontSize: 13, color: C.text2, textAlign: "center", marginBottom: 22 }}>
          {info.host_name ? `Приглашает ${info.host_name}` : "Подключение к встрече"}
        </div>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Ваше имя
        </label>
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !submitting) void submit(); }}
          placeholder="Например, Иван Петров"
          style={{ width: "100%", padding: "11px 14px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, color: C.text, background: C.card, outline: "none", fontFamily: "inherit", marginBottom: 16 }}
          autoFocus />

        {submitErr && (
          <div style={{ padding: "9px 12px", background: C.errBg, border: `1px solid ${C.errBrd}`, borderRadius: 8, color: C.err, fontSize: 12.5, marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {submitErr}
          </div>
        )}

        <button onClick={() => void submit()} disabled={submitting}
          style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: submitting ? C.bg3 : C.acc, color: submitting ? C.text3 : "white", fontWeight: 600, fontSize: 14, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {submitting ? <><Loader2 size={16} className="lk-spin" /> Отправляем…</> : <><Video size={16} /> Постучаться в комнату</>}
        </button>
        <style>{`.lk-spin{animation:lk-spin 1s linear infinite}@keyframes lk-spin{to{transform:rotate(360deg)}}`}</style>

        <div style={{ marginTop: 18, fontSize: 11.5, color: C.text3, textAlign: "center", lineHeight: 1.5 }}>
          Организатор должен подтвердить ваш вход. После этого вы попадёте в комнату.
        </div>
      </div>
    </div>
  );
}

function CenterCard({ icon, title, sub }: { icon: "err" | "load"; title: string; sub?: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: C.bg, fontFamily: "'Outfit', system-ui, sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: icon === "err" ? C.errBg : C.bg3, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          {icon === "err" ? <AlertCircle size={26} color={C.err} /> : <Loader2 size={26} color={C.text2} className="lk-spin" />}
        </div>
        <h2 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 600, color: C.text }}>{title}</h2>
        {sub && <p style={{ margin: 0, fontSize: 13.5, color: C.text2, lineHeight: 1.5 }}>{sub}</p>}
        <style>{`.lk-spin{animation:lk-spin 1s linear infinite}@keyframes lk-spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
}
