// Slots und Scheduler: hoechstens MAX_PARALLEL Runs gleichzeitig, auch ueber
// mehrere Prozesse auf derselben SQLite-Datei (CLI und Daemon). Die Slot-Vergabe
// zaehlt die Zeilen in `slots` innerhalb derselben BEGIN-IMMEDIATE-Transaktion.
// Reihenfolge und Vergabe sind deterministisch: aelteste wartende Auftraege zuerst.
import { basename } from "node:path";
import type { RunResult } from "./orchestrator";
import type { Store, WorkItem } from "./store";
import { HEARTBEAT_MS, LEASE_TIMEOUT_MS, ensureLeaseSchema, expireLeases } from "./leases";
import { NightConfig, isInWindow, nightReport, nightTokensUsed, windowEnd, windowStart } from "./night";

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
  /** Nachtbetrieb: Auftraege mit `state.night === true` starten nur im Fenster und innerhalb des Budgets. */
  night?: NightConfig;
}

/** Kennung des Morgenberichts je Nacht: `night_report`-Freigaben haengen an keinem Auftrag. */
function nightId(since: Date): string {
  return `night:${since.toISOString()}`;
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
  const night = opts.night ?? NightConfig.parse({});

  /** Schreibt `night.budget_reached` hoechstens einmal je Nacht (Dedup ueber das Event-Log, prozessuebergreifend). */
  function budgetReachedOnce(since: Date, t: number, used: number): void {
    const seen = store.events({ type: "night.budget_reached" }).some((e) => new Date(e.ts).getTime() >= since.getTime());
    if (seen) return;
    store.append({
      ts: new Date(t).toISOString(),
      traceId: nightId(since),
      spanId: nightId(since),
      parentSpanId: null,
      project: "usac",
      type: "night.budget_reached",
      actor: "orchestrator",
      data: { since: since.toISOString(), used, max_tokens: night.max_tokens },
    });
  }

  /** Morgenbericht: erster Tick nach Fensterende legt je Nacht genau eine offene Freigabe `night_report` an. Blockiert nicht. */
  function morningReportOnce(t: number): void {
    const d = new Date(t);
    if (isInWindow(d, night.window)) return;
    const since = windowStart(d, night.window);
    const until = windowEnd(since, night.window);
    const existing = store.db.query("SELECT context FROM approvals WHERE kind = 'night_report'").all() as { context: string }[];
    if (existing.some((r) => (JSON.parse(r.context) as { since?: string }).since === since.toISOString())) return;
    // Ohne Nachtauftrag, der in dieser Nacht tatsaechlich gestartet ist, gibt es keinen Bericht.
    const nightIds = new Set(store.listWorkItems().filter((w) => w.state.night === true).map((w) => w.id));
    const ran = store.events({ type: "slot.acquired" }).some((e) => {
      const at = new Date(e.ts).getTime();
      return nightIds.has(e.traceId) && at >= since.getTime() && at < until.getTime();
    });
    if (!ran) return;
    const report = nightReport(store.events(), since, until);
    store.createApproval(nightId(since), "night_report", { since: since.toISOString(), until: until.toISOString(), ...report });
  }

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
      morningReportOnce(t);
      const queued = store.db
        .query("SELECT id FROM workitems WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC")
        .all() as { id: string }[];
      const started: string[] = [];
      for (const { id } of queued) {
        if (running.has(id)) continue;
        const wi = store.getWorkItem(id);
        if (wi?.state.night === true) {
          const d = new Date(t);
          if (!isInWindow(d, night.window)) continue;
          const since = windowStart(d, night.window);
          const used = nightTokensUsed(store.events({ type: "run.finished" }), since);
          if (used >= night.max_tokens) {
            budgetReachedOnce(since, t, used);
            continue;
          }
          // max_parallel begrenzt Nachtlaeufe zusaetzlich zum Scheduler-Limit; der kleinere Wert gewinnt.
          const nightRunning = [...running.keys()].filter((r) => store.getWorkItem(r)?.state.night === true).length;
          if (nightRunning >= night.max_parallel) continue;
        }
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
