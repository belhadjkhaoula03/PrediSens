const CACHE_NAME = "predimaint-shell-v27";
const APP_SHELL = [
  "/",
  "/static/styles.css?v=27",
  "/static/measurement-ui.js?v=27",
  "/static/profile.js?v=27",
  "/static/director.js?v=27",
  "/static/app.js?v=27",
  "/static/admin.js?v=27",
  "/static/technician.js?v=27",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(payload.title || "PrediMaint", {
    body: payload.body || "Une nouvelle notification vous est adressée.",
    data: { url: payload.url || "/#tech-notifications" },
    tag: payload.tag || "predimaint-notification",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/#tech-notifications", self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === destination.origin);
    if (existing) {
      return existing.navigate(destination.href).then((client) => client.focus());
    }
    return self.clients.openWindow(destination.href);
  }));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/static/")) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
  }
});
