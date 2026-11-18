// Lokale Benachrichtigungen (Phase 5, ADR 0010): Service Worker plus WebSocket, kein Web Push.
// Als <script type="module"> geladen. toNotification ist rein und in Tests importierbar.

/**
 * Ordnet einen Event-Strom-Eintrag einer Benachrichtigung zu, oder null, wenn er keine meldet.
 * @param {{id: number, traceId: string, type: string, data?: any}} event
 * @returns {{title: string, body: string, url: string, tag: string} | null}
 */
export function toNotification(event) {
  const id = encodeURIComponent(event.traceId);
  const tag = String(event.id);
  switch (event.type) {
    case "approval.requested":
      return {
        title: `Freigabe ${event.data && event.data.kind ? event.data.kind : "?"}`,
        body: `Auftrag ${event.traceId}`,
        url: `/runs/${id}/review`,
        tag,
      };
    case "workitem.escalated":
      return { title: "Auftrag eskaliert", body: event.traceId, url: `/runs/${id}`, tag };
    case "workitem.failed":
      return { title: "Auftrag fehlgeschlagen", body: event.traceId, url: `/runs/${id}`, tag };
    default:
      return null;
  }
}

const canNotify =
  typeof window !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator;

if (canNotify) {
  const startedAt = Date.now();
  let registrationPromise = null;

  // Der Server spielt beim Verbinden den gesamten Verlauf ab; nur Ereignisse ab Seitenstart melden.
  function connect(registration) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/ws`);
    ws.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (Date.parse(event.ts) < startedAt) return;
      if (Notification.permission !== "granted") return;
      const note = toNotification(event);
      if (!note) return;
      registration.showNotification(note.title, { body: note.body, tag: note.tag, data: { url: note.url } });
    };
    ws.onclose = () => setTimeout(() => connect(registration), 3000);
  }

  if (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    registrationPromise = navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }

  const button = document.getElementById("notify-enable");
  if (button) {
    button.addEventListener("click", () => {
      if (!("Notification" in window) || !registrationPromise) return;
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") registrationPromise.then(connect);
      });
    });
  }
}
