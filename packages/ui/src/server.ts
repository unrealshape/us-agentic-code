import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { Store } from "../../daemon/src/store";
import { openMemory } from "../../daemon/src/memory";
import { applyRoutingApproval, overridePathFor } from "../../daemon/src/orchestrator";
import { loadRouting } from "../../daemon/src/routing";
import { registerActions, type Guard } from "./actions";
import { registerKnowledgeActions } from "./knowledge-actions";
import { inboxData, inboxHtml } from "./views/inbox";
import { wallData, wallHtml } from "./views/wall";
import { runData, runHtml } from "./views/run";
import { pipelineHtml } from "./views/pipeline";
import { registerReview } from "./views/review";
import { registerKnowledge } from "./views/knowledge";
import { registerMetrics } from "./views/metrics";
import { commandsData, registerPalette } from "./views/palette";
import { dashboardData, dashboardHtml } from "./views/dashboard";

/** Wurzel des Plugins (routing.yaml, workflows/) relativ zu diesem Modul. */
const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
/** Statische Dateien der PWA. */
const PUBLIC_DIR = resolve(import.meta.dir, "../public");

/** Zusatzwerte fuer die volle UI (Phase 5). Ohne sie verhaelt sich die App wie UI v1. */
export type AppDeps = {
  pluginRoot?: string;
  /** ~/.usac oder ein Testordner: dort liegen Memory, Routing-Overrides und Projektdaten. */
  home?: string;
  memoryPath?: string;
  /** Schutz fuer schreibende Aktionen und Token-Seiten; ohne ihn gibt es keine Aktionsrouten. */
  guard?: Guard;
};

/** Erster Montag nach dem ersten Ereignis (Installation); Grundlage der Zeitraeume (ADR 0003). */
function defaultPeriodStart(store: Store, now: Date): Date {
  const first = store.events()[0];
  const base = first ? new Date(first.ts) : now;
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d;
}

const STATIC: [string, string][] = [
  ["/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  ["/sw.js", "text/javascript; charset=utf-8"],
  ["/notify.js", "text/javascript; charset=utf-8"],
  ["/icon.svg", "image/svg+xml"],
];

export function createApp(store: Store, deps?: AppDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => c.redirect("/dashboard"));
  app.get("/inbox", (c) => c.html(inboxHtml(store, deps?.guard?.token)));
  app.get("/wall", (c) => c.html(wallHtml(store)));
  app.get("/runs/:id", (c) => c.html(runHtml(store, c.req.param("id"))));
  app.get("/api/inbox", (c) => c.json(inboxData(store)));
  app.get("/api/wall", (c) => c.json(wallData(store)));
  app.get("/api/runs/:id", (c) => c.json(runData(store, c.req.param("id"))));
  if (!deps) return app;

  const pluginRoot = deps.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const guard = deps.guard;
  const home = deps.home;
  const overridePath = home ? overridePathFor(home) : undefined;

  app.get("/runs/:id/pipeline", (c) => c.html(pipelineHtml(store, pluginRoot, c.req.param("id"))));
  registerReview(app, store, guard);

  if (home) {
    const memory = openMemory(deps.memoryPath ?? join(home, "memory.db"));
    registerKnowledge(app, { memory, home, store }, guard);
    if (guard) registerKnowledgeActions(app, { memory, store }, guard);
  }

  const now = new Date();
  const routing = loadRouting(pluginRoot, overridePath);
  registerMetrics(app, { store, routing, periodStart: defaultPeriodStart(store, now), periodDays: 7 });

  app.get("/api/commands", (c) => c.json(commandsData(store)));
  app.get("/dashboard", (c) =>
    c.html(dashboardHtml(store, { storyId: c.req.query("story") || undefined, view: c.req.query("view"), range: c.req.query("range") })),
  );
  app.get("/api/dashboard", (c) =>
    c.json(dashboardData(store, { storyId: c.req.query("story") || undefined, view: c.req.query("view"), range: c.req.query("range") })),
  );
  registerPalette(app, store);
  for (const [path, type] of STATIC) {
    app.get(path, () => new Response(Bun.file(join(PUBLIC_DIR, path.slice(1))), { headers: { "content-type": type, "cache-control": "no-cache" } }));
  }

  if (guard) {
    // Herabstufung: nur beim Wechsel von offen auf erteilt wird der Override geschrieben (sonst nie doppelt).
    if (overridePath) {
      app.use("/api/approvals/:id", async (c, next) => {
        const id = Number(c.req.param("id"));
        const before = Number.isInteger(id) ? store.getApproval(id) : undefined;
        await next();
        if (before?.status === "pending" && c.res.status === 200) {
          const after = store.getApproval(id);
          if (after) applyRoutingApproval(after, overridePath, new Date());
        }
      });
    }
    registerActions(app, store, guard);
  }
  return app;
}

/**
 * Startet den Server; bindet ausschliesslich an 127.0.0.1. Jeder Start erzeugt einen neuen Token
 * fuer schreibende Aktionen. Jede Anfrage braucht den Host `127.0.0.1:<port>`, sonst 403.
 * /ws liefert den Event-Strom und verlangt die eigene Origin.
 */
export function startServer(store: Store, opts: { port?: number; pluginRoot?: string; home?: string; memoryPath?: string } = {}) {
  const guard: Guard = { token: randomBytes(32).toString("hex"), port: 0 };
  const app = createApp(store, { guard, ...(opts.pluginRoot ? { pluginRoot: opts.pluginRoot } : {}), ...(opts.home ? { home: opts.home } : {}), ...(opts.memoryPath ? { memoryPath: opts.memoryPath } : {}) });
  type WsData = { lastId: number; timer?: ReturnType<typeof setInterval> };
  const srv = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 7777,
    fetch(req, server) {
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`) {
        return new Response("Host nicht erlaubt", { status: 403 });
      }
      if (new URL(req.url).pathname === "/ws") {
        // Nur die eigene Seite darf den Event-Strom lesen (Schutz gegen Cross-Site-WebSocket).
        if (req.headers.get("origin") !== `http://127.0.0.1:${server.port}`) {
          return new Response("Origin nicht erlaubt", { status: 403 });
        }
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
  // Erst nach dem Start kennt der Server seinen Port; Anfragen kommen erst danach an.
  guard.port = srv.port!;
  return srv;
}
