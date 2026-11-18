/**
 * Schreibende Aktionen der Wissens-Ansicht: Memory-Eintrag verifizieren, Instinct stilllegen.
 * Gleicher Schutz wie die Review-Aktionen (`checkRequest`): nur POST, Token je Serverstart,
 * `Origin` und `Host` exakt 127.0.0.1:<port>.
 */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context, Hono } from "hono";
import type { Store } from "../../daemon/src/store";
import { verifyEntry } from "../../daemon/src/memory";
import { getInstinct, retireInstinct } from "../../daemon/src/instincts";
import { checkRequest, type Guard } from "./actions";

export type KnowledgeActionDeps = { memory: Database; store: Store };

const real = (p: string): string | null => {
  try {
    return realpathSync(resolve(p));
  } catch {
    return null;
  }
};

/** Liegt `root` (aufgeloest, ohne Symlinks) in einem registrierten Projekt (`projectPath` der Auftraege)? */
export function insideRegisteredProject(store: Store, root: string): string | null {
  const r = real(root);
  if (!r) return null;
  for (const wi of store.listWorkItems()) {
    const p = real(wi.projectPath);
    if (!p) continue;
    const rel = relative(p, r);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return r;
  }
  return null;
}

async function guarded(c: Context, g: Guard): Promise<{ body: Record<string, unknown> } | Response> {
  if (c.req.method !== "POST") return c.json({ error: "Nur POST erlaubt" }, 405, { Allow: "POST" });
  const reason = checkRequest(c.req.raw, g);
  if (reason) return c.json({ error: reason }, 403);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON erwartet" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "JSON-Objekt erwartet" }, 400);
  return { body: body as Record<string, unknown> };
}

/**
 * `POST /api/memory/:uid/verify {root}`: Zitatpruefung gegen eine Wurzel unterhalb eines
 * registrierten Projekts. `POST /api/instincts/:id/retire {reason}`: Stilllegung mit Grund;
 * bereits stillgelegte Instincts bleiben unveraendert (409). Andere Methoden: 405.
 */
export function registerKnowledgeActions(app: Hono, deps: KnowledgeActionDeps, g: Guard): void {
  app.all("/api/memory/:uid/verify", async (c) => {
    const r = await guarded(c, g);
    if (r instanceof Response) return r;
    const uid = c.req.param("uid");
    if (!/^[0-9a-f]{16}$/.test(uid)) return c.json({ error: "Ungueltige Memory-UID" }, 400);
    const { root } = r.body;
    if (typeof root !== "string" || !root.trim()) return c.json({ error: "root muss Text sein" }, 400);
    const dir = insideRegisteredProject(deps.store, root);
    if (!dir) return c.json({ error: "root liegt in keinem registrierten Projekt" }, 400);
    const row = deps.memory.query("SELECT id FROM entries WHERE uid = ?").get(uid) as { id: number } | null;
    if (!row) return c.json({ error: `Memory-Eintrag ${uid} nicht gefunden` }, 404);
    let verified: boolean;
    try {
      verified = verifyEntry(deps.memory, row.id, dir);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const status = (deps.memory.query("SELECT status FROM entries WHERE id = ?").get(row.id) as { status: string }).status;
    return c.json({ ok: true, verified, status });
  });

  app.all("/api/instincts/:id/retire", async (c) => {
    const r = await guarded(c, g);
    if (r instanceof Response) return r;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Ungueltige Instinct-ID" }, 400);
    const { reason } = r.body;
    if (typeof reason !== "string" || !reason.trim()) return c.json({ error: "reason muss nicht-leerer Text sein" }, 400);
    const i = getInstinct(deps.memory, id);
    if (!i) return c.json({ error: `Instinct ${id} nicht gefunden` }, 404);
    if (i.status === "retired") return c.json({ error: `Instinct ${id} ist bereits stillgelegt` }, 409);
    retireInstinct(deps.memory, id, reason);
    return c.json({ ok: true, instinct: getInstinct(deps.memory, id) });
  });
}
