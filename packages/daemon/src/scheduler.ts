// Slots und Scheduler: hoechstens MAX_PARALLEL Runs gleichzeitig, auch ueber
// mehrere Prozesse auf derselben SQLite-Datei (CLI und Daemon). Die Slot-Vergabe
// zaehlt die Zeilen in `slots` innerhalb derselben BEGIN-IMMEDIATE-Transaktion.
// Reihenfolge und Vergabe sind deterministisch: aelteste wartende Auftraege zuerst.
import { basename } from "node:path";
import type { RunResult } from "./orchestrator";
import type { Store, WorkItem } from "./store";
import { HEARTBEAT_MS, LEASE_TIMEOUT_MS, ensureLeaseSchema, expireLeases } from "./leases";

export const MAX_PARALLEL = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  work_item_id TEXT PRIMARY KEY,
  started_at INTEGER,
  heartbeat_at INTEGER
);
`;

export function ensureSlotSchema(store: Store): void {
  store.db.exec(SCHEMA);
}

function emit(store: Store, wi: WorkItem, type: string, data: unknown = {}): void {
  store.append({
    traceId: wi.id,
    spanId: wi.id,
    parentSpanId: null,
    project: basename(wi.projectPath),
    type,
    actor: "orchestrator",
    data,
  });
}

/**
 * Vergibt einen Slot, wenn weniger als `max` belegt sind und der Auftrag noch
 * keinen haelt. Setzt den Auftrag im selben Schritt auf `running`, damit ein
 * zweiter Prozess ihn nicht ebenfalls startet.
 */
export function tryAcquireSlot(store: Store, wiId: string, max: number, now: number): boolean {
  const tx = store.db.transaction((): boolean => {
    const own = store.db.query("SELECT 1 FROM slots WHERE work_item_id = ?").get(wiId);
    if (own) return false;
    const { n } = store.db.query("SELECT COUNT(*) AS n FROM slots").get() as { n: number };
    if (n >= max) return false;
    const wi = store.db.query("SELECT status FROM workitems WHERE id = ?").get(wiId) as { status: string } | null;
    if (!wi || wi.status !== "queued") return false;
    store.db.query("INSERT INTO slots (work_item_id, started_at, heartbeat_at) VALUES (?, ?, ?)").run(wiId, now, now);
    store.db.query("UPDATE workitems SET status = 'running' WHERE id = ?").run(wiId);
    return true;
  });
  return tx.immediate();
}

export function slotHeartbeat(store: Store, wiId: string, now: number): void {
  store.db.query("UPDATE slots SET heartbeat_at = ? WHERE work_item_id = ?").run(now, wiId);
}

export function releaseSlot(store: Store, wiId: string): void {
  store.db.query("DELETE FROM slots WHERE work_item_id = ?").run(wiId);
}

/**
 * Gibt Slots ohne Heartbeat seit `timeoutMs` frei. Auftraege, die dabei noch
 * auf `running` stehen (abgestuerzter Prozess), gehen zurueck auf `queued`.
 * Liefert die IDs der freigegebenen Slots.
 */
export function expireSlots(store: Store, now: number, timeoutMs: number = LEASE_TIMEOUT_MS): string[] {
  const tx = store.db.transaction((): { id: string; requeued: boolean }[] => {
    const rows = store.db
      .query("SELECT work_item_id AS id FROM slots WHERE heartbeat_at IS NULL OR heartbeat_at < ? ORDER BY work_item_id")
      .all(now - timeoutMs) as { id: string }[];
    const out: { id: string; requeued: boolean }[] = [];
    for (const r of rows) {
      store.db.query("DELETE FROM slots WHERE work_item_id = ?").run(r.id);
      const changed = store.db.query("UPDATE workitems SET status = 'queued' WHERE id = ? AND status = 'running'").run(r.id).changes;
      out.push({ id: r.id, requeued: changed > 0 });
    }
    return out;
  });
  const expired = tx.immediate();
  for (const e of expired) {
    const wi = store.getWorkItem(e.id);
    if (!wi) continue;
    emit(store, wi, "slot.expired", { requeued: e.requeued });
    if (e.requeued) emit(store, wi, "workitem.queued", { reason: "slot.expired" });
  }
  return expired.map((e) => e.id);
}

export interface SchedulerOptions {
  store: Store;
  run: (id: string) => Promise<RunResult>;
  maxParallel?: number;
  now?: () => number;
}

export interface Scheduler {
  enqueue(id: string): void;
  tick(): Promise<string[]>;
  idle(): Promise<void>;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { store } = opts;
  const max = opts.maxParallel ?? MAX_PARALLEL;
  const now = opts.now ?? (() => Date.now());
  ensureSlotSchema(store);
  ensureLeaseSchema(store);
  const running = new Map<string, Promise<void>>();

  function start(id: string): void {
    const wi = store.getWorkItem(id)!;
    emit(store, wi, "slot.acquired", { max });
    const timer = setInterval(() => slotHeartbeat(store, id, now()), HEARTBEAT_MS);
    (timer as { unref?: () => void }).unref?.();
    const done = (async () => {
      let result: RunResult | null = null;
      let error: string | undefined;
      try {
        result = await opts.run(id);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        clearInterval(timer);
        releaseSlot(store, id);
      }
      const cur = store.getWorkItem(id);
      if (!cur) return;
      // Der Orchestrator schreibt den Status selbst; nur ein haengendes `running` wird nachgezogen.
      if (cur.status === "running") store.updateWorkItem(id, { status: result ? result.status : "failed" });
      emit(store, store.getWorkItem(id)!, "slot.released", { status: result?.status ?? "failed", ...(error ? { error } : {}) });
    })();
    running.set(id, done);
    void done.finally(() => running.delete(id));
  }

  return {
    enqueue(id: string): void {
      const wi = store.getWorkItem(id);
      if (!wi) throw new Error(`WorkItem ${id} nicht gefunden`);
      if (wi.status !== "queued") store.updateWorkItem(id, { status: "queued" });
      emit(store, store.getWorkItem(id)!, "workitem.queued", {});
    },

    async tick(): Promise<string[]> {
      const t = now();
      for (const id of running.keys()) slotHeartbeat(store, id, t);
      expireSlots(store, t);
      expireLeases(store, t);
      const queued = store.db
        .query("SELECT id FROM workitems WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC")
        .all() as { id: string }[];
      const started: string[] = [];
      for (const { id } of queued) {
        if (running.has(id)) continue;
        if (!tryAcquireSlot(store, id, max, t)) continue;
        started.push(id);
        start(id);
      }
      return started;
    },

    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
