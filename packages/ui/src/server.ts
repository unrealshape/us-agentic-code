import { Hono } from "hono";
import type { Store } from "../../daemon/src/store";
import { inboxData, inboxHtml } from "./views/inbox";
import { wallData, wallHtml } from "./views/wall";
import { runData, runHtml } from "./views/run";

export function createApp(store: Store): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(inboxHtml(store)));
  app.get("/wall", (c) => c.html(wallHtml(store)));
  app.get("/runs/:id", (c) => c.html(runHtml(store, c.req.param("id"))));
  app.get("/api/inbox", (c) => c.json(inboxData(store)));
  app.get("/api/wall", (c) => c.json(wallData(store)));
  app.get("/api/runs/:id", (c) => c.json(runData(store, c.req.param("id"))));
  return app;
}

/** Startet den Server; bindet ausschliesslich an 127.0.0.1. /ws liefert den Event-Strom. */
export function startServer(store: Store, opts: { port?: number } = {}) {
  const app = createApp(store);
  type WsData = { lastId: number; timer?: ReturnType<typeof setInterval> };
  return Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 7777,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        const lastId = Number(new URL(req.url).searchParams.get("since") ?? 0) || 0;
        if (server.upgrade(req, { data: { lastId } })) return undefined;
        return new Response("Upgrade fehlgeschlagen", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const push = () => {
          for (const e of store.events({ sinceId: ws.data.lastId })) {
            ws.send(JSON.stringify(e));
            ws.data.lastId = e.id;
          }
        };
        push();
        ws.data.timer = setInterval(push, 1000);
      },
      close(ws) {
        if (ws.data.timer) clearInterval(ws.data.timer);
      },
      message() {},
    },
  });
}
