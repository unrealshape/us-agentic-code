/**
 * Schreibende UI-Aktionen (Freigeben, Ablehnen). Schutz gegen CSRF und DNS-Rebinding:
 * nur POST, Token je Serverstart im Header `X-Usac-Token` (Vergleich in konstanter Zeit),
 * `Origin` und `Host` muessen exakt 127.0.0.1:<port> sein.
 */
import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import type { Hono } from "hono";
import type { Store } from "../../daemon/src/store";

export type Guard = { token: string; port: number };

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Laenge ist kein Geheimnis (32 Byte Zufall, fest kodiert); nur der Inhalt wird konstant verglichen.
  if (a.length !== b.length || b.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Prueft eine schreibende Anfrage; liefert den Ablehnungsgrund oder null. */
export function checkRequest(req: Request, g: Guard): string | null {
  if (req.method !== "POST") return "Nur POST erlaubt";
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${g.port}`) return "Host nicht erlaubt";
  const origin = req.headers.get("origin");
  if (origin !== `http://127.0.0.1:${g.port}`) return "Origin nicht erlaubt";
  const token = req.headers.get("x-usac-token");
  if (!token || !sameToken(token, g.token)) return "Token fehlt oder ist falsch";
  return null;
}

/**
 * Entscheidet eine offene Freigabe aus der UI. Wie `usac approve`: der wartende Auftrag geht
 * zurueck auf `queued`, der Daemon setzt ihn im naechsten Takt fort (Freigaben der Art
 * `protector` blockieren nie und reihen nichts ein). Bereits entschiedene Freigaben bleiben.
 */
export function resolveFromUi(store: Store, approvalId: number, granted: boolean, note?: string): void {
  const a = store.getApproval(approvalId);
  if (!a) throw new Error(`Freigabe ${approvalId} nicht gefunden`);
  if (a.status !== "pending") throw new Error(`Freigabe ${approvalId} ist bereits entschieden (${a.status})`);
  store.resolveApproval(approvalId, granted, note);
  const wi = store.getWorkItem(a.workItemId);
  const project = wi ? basename(wi.projectPath) : "";
  const traceId = a.workItemId;
  store.append({
    traceId,
    spanId: traceId,
    parentSpanId: null,
    project,
    type: "approval.resolved",
    actor: "user",
    data: { approval_id: approvalId, granted, by: "ui" },
  });
  if (wi && wi.status === "awaiting_approval" && a.kind !== "protector") {
    store.updateWorkItem(wi.id, { status: "queued" });
    store.append({
      traceId,
      spanId: traceId,
      parentSpanId: null,
      project,
      type: "workitem.queued",
      actor: "orchestrator",
      data: { reason: "approval", approval_id: approvalId, kind: a.kind },
    });
  }
}

/** POST /api/approvals/:id mit JSON `{granted: boolean, note?: string}`; andere Methoden: 405. */
export function registerActions(app: Hono, store: Store, g: Guard): void {
  app.all("/api/approvals/:id", async (c) => {
    if (c.req.method !== "POST") return c.json({ error: "Nur POST erlaubt" }, 405, { Allow: "POST" });
    const reason = checkRequest(c.req.raw, g);
    if (reason) return c.json({ error: reason }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Ungueltige Freigabe-ID" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "JSON erwartet" }, 400);
    }
    const { granted, note } = (body ?? {}) as { granted?: unknown; note?: unknown };
    if (typeof granted !== "boolean") return c.json({ error: "granted muss boolean sein" }, 400);
    if (note !== undefined && typeof note !== "string") return c.json({ error: "note muss Text sein" }, 400);
    const a = store.getApproval(id);
    if (!a) return c.json({ error: `Freigabe ${id} nicht gefunden` }, 404);
    if (a.status !== "pending") return c.json({ error: `Freigabe ${id} ist bereits entschieden` }, 409);
    resolveFromUi(store, id, granted, note);
    return c.json({ ok: true, approval: store.getApproval(id) });
  });
}
