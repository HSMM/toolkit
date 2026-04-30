const CACHE_NAME = "toolkit-phone-v6";
const APP_SHELL = ["/softphone", "/manifest.webmanifest", "/pwa-icon.svg"];
const PHONE_NOTIFICATION_MESSAGE = "toolkit-phone-notification-action";
const PHONE_NOTIFICATION_CHANNEL = "toolkit-phone-notifications";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/oauth") || url.pathname.startsWith("/rtc")) return;

  if (request.mode === "navigate") {
    const fallback = "/softphone";
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok && response.status !== 206) {
            caches.open(CACHE_NAME).then((cache) => cache.put(fallback, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match(fallback)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.status !== 206) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
      }
      return response;
    })),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action || "open";
  const url = "/softphone";
  const message = {
    type: PHONE_NOTIFICATION_MESSAGE,
    action,
    callId: data.callId,
  };

  notification.close();

  event.waitUntil((async () => {
    if ("BroadcastChannel" in self) {
      const channel = new BroadcastChannel(PHONE_NOTIFICATION_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = windows.find((item) => {
      try {
        return new URL(item.url).pathname === url;
      } catch {
        return false;
      }
    });

    if (!client) {
      client = await self.clients.openWindow(url);
    } else if ("focus" in client) {
      await client.focus();
    }

    client?.postMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 250));
    client?.postMessage(message);
  })());
});
