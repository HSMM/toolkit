export type SoftphoneNotificationAction = "answer" | "reject" | "open";

const INCOMING_TAG = "toolkit-softphone-incoming-call";
const MESSAGE_TYPE = "toolkit-phone-notification-action";
const BROADCAST_CHANNEL = "toolkit-phone-notifications";

type NotificationPayload = {
  type: typeof MESSAGE_TYPE;
  action: SoftphoneNotificationAction;
  callId?: string;
};

export function notificationMessageType() {
  return MESSAGE_TYPE;
}

export function notificationBroadcastChannel() {
  return BROADCAST_CHANNEL;
}

export function isSoftphoneNotificationMessage(data: unknown): data is NotificationPayload {
  return Boolean(
    data
      && typeof data === "object"
      && (data as { type?: unknown }).type === MESSAGE_TYPE
      && typeof (data as { action?: unknown }).action === "string",
  );
}

export async function requestSoftphoneNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showIncomingCallNotification({
  number,
  callId,
}: {
  number: string;
  callId: string;
}) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    await requestSoftphoneNotificationPermission();
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  const options = {
    tag: INCOMING_TAG,
    renotify: true,
    requireInteraction: true,
    icon: "/pwa-icon.svg",
    badge: "/pwa-icon.svg",
    body: number,
    data: { callId, url: "/softphone" },
    actions: [
      { action: "answer", title: "Ответить" },
      { action: "reject", title: "Сбросить" },
    ],
  };

  if (registration?.showNotification) {
    await registration.showNotification("Входящий звонок", options as NotificationOptions);
    return;
  }

  new Notification("Входящий звонок", options as NotificationOptions);
}

export async function closeIncomingCallNotifications() {
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  const getNotifications = registration && "getNotifications" in registration
    ? (registration as ServiceWorkerRegistration & {
        getNotifications: (filter?: { tag?: string }) => Promise<Notification[]>;
      }).getNotifications.bind(registration)
    : null;

  if (!getNotifications) return;
  const notifications = await getNotifications({ tag: INCOMING_TAG }).catch(() => []);
  notifications.forEach((notification) => notification.close());
}
