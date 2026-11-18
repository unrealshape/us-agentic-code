// Datei-Leases mit Heartbeat (ADR 0004).
// Ein Lease reserviert einen Pfad eines Projekts fuer genau einen Auftrag.
// Vergabe und Freigabe laufen in BEGIN-IMMEDIATE-Transaktionen, damit CLI und
// Daemon auf derselben SQLite-Datei dieselben Grenzen sehen.
import type { Store } from "./store";

export const LEASE_TIMEOUT_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
/** Projektweiter Lease: kollidiert mit jedem Pfad desselben Projekts. */
export const PROJECT_WIDE = "*";

export type LeaseConflict = { path: string; holder: string };
export type AcquireResult = { ok: true } | { ok: false; conflicts: LeaseConflict[] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  PRIMARY KEY(project, path)
);
CREATE INDEX IF NOT EXISTS leases_holder ON leases(work_item_id);
`;

export function ensureLeaseSchema(store: Store): void {
  store.db.exec(SCHEMA);
}

/** `\` → `/`, fuehrendes `./` weg, doppelte `/` zusammen. */
export function normalizeLeasePath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

type LeaseRow = { path: string; work_item_id: string };

/** Alles oder nichts: entweder alle Pfade werden vergeben oder keiner. */
export function acquireLeases(store: Store, project: string, wiId: string, paths: string[], now: number): AcquireResult {
  const wanted = [...new Set(paths.map(normalizeLeasePath))];
  const tx = store.db.transaction((): AcquireResult => {
    const held = store.db
      .query("SELECT path, work_item_id FROM leases WHERE project = ? AND work_item_id <> ? ORDER BY path")
      .all(project, wiId) as LeaseRow[];
    const conflicts: LeaseConflict[] = [];
    const seen = new Set<string>();
    const add = (c: LeaseConflict) => {
      const key = `${c.path}\0${c.holder}`;
      if (seen.has(key)) return;
      seen.add(key);
      conflicts.push(c);
    };
    for (const path of wanted) {
      for (const row of held) {
        if (path === PROJECT_WIDE) add({ path: row.path, holder: row.work_item_id });
        else if (row.path === path || row.path === PROJECT_WIDE) add({ path, holder: row.work_item_id });
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    const insert = store.db.query(
      `INSERT INTO leases (project, path, work_item_id, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project, path) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
       WHERE leases.work_item_id = excluded.work_item_id`,
    );
    for (const path of wanted) insert.run(project, path, wiId, now, now);
    return { ok: true };
  });
  return tx.immediate();
}

/** Frischt alle Leases eines Auftrags auf; liefert die Anzahl. */
export function heartbeat(store: Store, wiId: string, now: number): number {
  return store.db.query("UPDATE leases SET heartbeat_at = ? WHERE work_item_id = ?").run(now, wiId).changes;
}

/** Gibt alle Leases eines Auftrags frei; liefert die Anzahl. */
export function releaseLeases(store: Store, wiId: string): number {
  return store.db.query("DELETE FROM leases WHERE work_item_id = ?").run(wiId).changes;
}

/**
 * Gibt verfallene Leases frei: Auftrag beendet (`done`, `failed`, `escalated`)
 * oder aktiv (`running`, `queued`) ohne Heartbeat seit `timeoutMs`.
 * Wartende Auftraege (`awaiting_approval`) verlieren ihre Leases nie.
 */
export function expireLeases(store: Store, now: number, timeoutMs: number = LEASE_TIMEOUT_MS): LeaseConflict[] {
  const tx = store.db.transaction((): LeaseConflict[] => {
    const rows = store.db
      .query(
        `SELECT l.project, l.path, l.work_item_id FROM leases l JOIN workitems w ON w.id = l.work_item_id
         WHERE w.status IN ('done', 'failed', 'escalated')
            OR (w.status IN ('running', 'queued') AND l.heartbeat_at < ?)
         ORDER BY l.project, l.path`,
      )
      .all(now - timeoutMs) as (LeaseRow & { project: string })[];
    const del = store.db.query("DELETE FROM leases WHERE project = ? AND path = ?");
    for (const r of rows) del.run(r.project, r.path);
    return rows.map((r) => ({ path: r.path, holder: r.work_item_id }));
  });
  return tx.immediate();
}

/** Pfade, die ein Auftrag haelt, sortiert. */
export function leasesOf(store: Store, wiId: string): string[] {
  return (
    store.db.query("SELECT path FROM leases WHERE work_item_id = ? ORDER BY project, path").all(wiId) as { path: string }[]
  ).map((r) => r.path);
}
