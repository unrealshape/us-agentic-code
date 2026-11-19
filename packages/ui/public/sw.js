// Service Worker der UI (Phase 5, ADR 0010). Cacht nur die Shell; API und WebSocket bleiben immer live.
const CACHE = "usac-shell-v2";
// Nur statische Dateien vorladen. HTML-Seiten werden nie gecacht, weil sie das Schreib-Token enthalten.
const SHELL = ["/palette.js", "/notify.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  // Einzeln laden: ein fehlender Eintrag darf die Installation nicht abbrechen.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((path) => cache.add(path).catch(() => undefined))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Netz zuerst, bei Fehler der Cache. /api/*, /ws und HTML-Seiten werden nie gecacht.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const type = response.headers.get("content-type") || "";
        if (response.ok && !type.includes("text/html")) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

// Klick auf eine Benachrichtigung: vorhandenes Fenster mit der Ziel-URL fokussieren, sonst neues öffnen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const match = clients.find((client) => client.url === target);
      if (match) return match.focus();
      return self.clients.openWindow(target);
    }),
  );
});
