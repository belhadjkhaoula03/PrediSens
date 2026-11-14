const CACHE_NAME = "predimaint-shell-v9";
const APP_SHELL = [
  "/",
  "/static/styles.css?v=9",
  "/static/profile.js?v=9",
  "/static/director.js?v=9",
  "/static/app.js?v=9",
  "/static/admin.js?v=9",
  "/static/technician.js?v=9",
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
