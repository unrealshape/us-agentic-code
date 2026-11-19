import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, Size, UsacEvent, WorkItemStatus, WorkItemType } from "@usac/shared";

export interface WorkItem {
  id: string;
  projectPath: string;
  type: WorkItemType;
  title: string;
  description: string;
  size: Size;
  status: WorkItemStatus;
  branch: string | null;
  worktree: string | null;
  state: Record<string, unknown>;
  createdAt: string;
}

/** Ein Rollen-Aufruf eines Auftrags (Story-Verlauf). */
export interface Step {
  id: number;
  workItemId: string;
  role: string;
  model: string;
  ok: boolean;
  reason?: string;
  files: string[];
  startedAt: string;
  endedAt: string;
  sliceId?: string;
  tokens: { input: number; output: number };
}

/** Ein Teilstueck einer Story mit eigenen Abnahmetests. */
export interface SliceRecord {
  id: string;
  title: string;
  position: number;
  criteria: string[];
  files: string[];
  dependsOn: string[];
  status: "pending" | "red" | "green";
}

export interface GateResult {
  id: number;
  workItemId: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface Approval {
  id: number;
  workItemId: string;
  kind: string;
  context: unknown;
  status: "pending" | "granted" | "denied";
  note: string | null;
}

export type NewEvent = Omit<UsacEvent, "id" | "ts"> & { ts?: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id, id);
CREATE TABLE IF NOT EXISTS workitems (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  size TEXT NOT NULL,
  status TEXT NOT NULL,
  branch TEXT,
  worktree TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workitem_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  output TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workitem_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  slice_id TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS steps_wi ON steps(workitem_id, id);
CREATE TABLE IF NOT EXISTS slices (
  workitem_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL,
  files TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (workitem_id, id)
);
CREATE TABLE IF NOT EXISTS acceptance_locks (
  workitem_id TEXT PRIMARY KEY,
  files TEXT NOT NULL,
  hash TEXT NOT NULL,
  locked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workitem_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  context TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);
`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Bestehende Datenbanken aus dem Stand vor den Slices: Spalte nachruesten (Fehler = Spalte gibt es schon).
    for (const col of ["slice_id TEXT", "tokens_in INTEGER NOT NULL DEFAULT 0", "tokens_out INTEGER NOT NULL DEFAULT 0"]) {
      try {
        this.db.exec(`ALTER TABLE steps ADD COLUMN ${col}`);
      } catch {
        // schon vorhanden
      }
    }
  }

  // ---- Events (nur anhaengen) ----------------------------------------------

  append(ev: NewEvent): UsacEvent {
    const ts = ev.ts ?? new Date().toISOString();
    const row = this.db
      .query(
        `INSERT INTO events (ts, trace_id, span_id, parent_span_id, project, type, actor, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(ts, ev.traceId, ev.spanId, ev.parentSpanId ?? null, ev.project, ev.type, ev.actor, JSON.stringify(ev.data ?? {})) as {
      id: number;
    };
    return { ...ev, id: row.id, ts, parentSpanId: ev.parentSpanId ?? null };
  }

  events(filter: { traceId?: string; sinceId?: number; type?: string; limit?: number } = {}): UsacEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.traceId) {
      where.push("trace_id = ?");
      args.push(filter.traceId);
    }
    if (filter.sinceId !== undefined) {
      where.push("id > ?");
      args.push(filter.sinceId);
    }
    if (filter.type) {
      where.push("type = ?");
      args.push(filter.type);
    }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ASC ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.query(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      ts: r.ts as string,
      traceId: r.trace_id as string,
      spanId: r.span_id as string,
      parentSpanId: (r.parent_span_id as string | null) ?? null,
      project: r.project as string,
      type: r.type as string,
      actor: r.actor as Actor,
      data: JSON.parse(r.data as string),
    }));
  }

  // ---- WorkItems ---------------------------------------------------------------

  createWorkItem(wi: Omit<WorkItem, "createdAt" | "branch" | "worktree" | "state" | "status">): WorkItem {
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO workitems (id, project_path, type, title, description, size, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(wi.id, wi.projectPath, wi.type, wi.title, wi.description, wi.size, createdAt);
    return this.getWorkItem(wi.id)!;
  }

  getWorkItem(id: string): WorkItem | null {
    const r = this.db.query("SELECT * FROM workitems WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: r.id as string,
      projectPath: r.project_path as string,
      type: r.type as WorkItemType,
      title: r.title as string,
      description: r.description as string,
      size: r.size as Size,
      status: r.status as WorkItemStatus,
      branch: (r.branch as string | null) ?? null,
      worktree: (r.worktree as string | null) ?? null,
      state: JSON.parse(r.state as string),
      createdAt: r.created_at as string,
    };
  }

  listWorkItems(): WorkItem[] {
    const ids = this.db.query("SELECT id FROM workitems ORDER BY created_at DESC").all() as { id: string }[];
    return ids.map((r) => this.getWorkItem(r.id)!);
  }

  updateWorkItem(id: string, patch: Partial<Pick<WorkItem, "status" | "branch" | "worktree" | "state" | "size">>): void {
    const cur = this.getWorkItem(id);
    if (!cur) throw new Error(`WorkItem ${id} nicht gefunden`);
    const next = { ...cur, ...patch };
    this.db
      .query("UPDATE workitems SET status = ?, branch = ?, worktree = ?, state = ?, size = ? WHERE id = ?")
      .run(next.status, next.branch, next.worktree, JSON.stringify(next.state), next.size, id);
  }

  // ---- Story-Schritte ------------------------------------------------------------

  /** Ein Rollen-Aufruf eines Auftrags: Rolle, Modell, Ergebnis, betroffene Dateien, Zeitraum. */
  recordStep(s: Omit<Step, "id" | "tokens"> & { tokens?: Step["tokens"] }): Step {
    const row = this.db
      .query(
        `INSERT INTO steps (workitem_id, role, model, ok, reason, files, started_at, ended_at, slice_id, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        s.workItemId,
        s.role,
        s.model,
        s.ok ? 1 : 0,
        s.reason ?? null,
        JSON.stringify(s.files),
        s.startedAt,
        s.endedAt,
        s.sliceId ?? null,
        s.tokens?.input ?? 0,
        s.tokens?.output ?? 0,
      ) as { id: number };
    return { ...s, id: row.id, tokens: s.tokens ?? { input: 0, output: 0 } };
  }

  /** Schritte eines Auftrags, ohne Angabe alle (neueste zuletzt). */
  listSteps(workItemId?: string): Step[] {
    const rows = (
      workItemId === undefined
        ? this.db.query("SELECT * FROM steps ORDER BY id").all()
        : this.db.query("SELECT * FROM steps WHERE workitem_id = ? ORDER BY id").all(workItemId)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      workItemId: r.workitem_id as string,
      role: r.role as string,
      model: r.model as string,
      ok: (r.ok as number) === 1,
      reason: (r.reason as string | null) ?? undefined,
      files: JSON.parse(r.files as string) as string[],
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string,
      ...(r.slice_id ? { sliceId: r.slice_id as string } : {}),
      tokens: { input: r.tokens_in as number, output: r.tokens_out as number },
    }));
  }

  // ---- Slices --------------------------------------------------------------------

  /** Ersetzt den Slice-Plan eines Auftrags; `order` bestimmt die Reihenfolge. */
  saveSlices(workItemId: string, slices: { id: string; title: string; criteria: string[]; files: string[]; depends_on: string[] }[], order: string[]): void {
    this.db.query("DELETE FROM slices WHERE workitem_id = ?").run(workItemId);
    for (const s of slices) {
      this.db
        .query(
          `INSERT INTO slices (workitem_id, id, position, title, criteria, files, depends_on, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(workItemId, s.id, Math.max(0, order.indexOf(s.id)), s.title, JSON.stringify(s.criteria), JSON.stringify(s.files), JSON.stringify(s.depends_on));
    }
  }

  setSliceStatus(workItemId: string, id: string, status: SliceRecord["status"]): void {
    this.db.query("UPDATE slices SET status = ? WHERE workitem_id = ? AND id = ?").run(status, workItemId, id);
  }

  listSlices(workItemId: string): SliceRecord[] {
    const rows = this.db.query("SELECT * FROM slices WHERE workitem_id = ? ORDER BY position").all(workItemId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      position: r.position as number,
      criteria: JSON.parse(r.criteria as string) as string[],
      files: JSON.parse(r.files as string) as string[],
      dependsOn: JSON.parse(r.depends_on as string) as string[],
      status: r.status as SliceRecord["status"],
    }));
  }

  /** Die letzten `limit` Events, aelteste zuerst. */
  recentEvents(limit: number): UsacEvent[] {
    const max = (this.db.query("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m;
    return this.events({ sinceId: Math.max(0, max - limit) });
  }

  /** Zeilenzahl der Tabellen, die das Dashboard zeigt. */
  tableCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of ["events", "workitems", "steps", "gate_results", "approvals"]) {
      out[t] = (this.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return out;
  }

  // ---- Gates ---------------------------------------------------------------------

  recordGate(g: Omit<GateResult, "id">): GateResult {
    const row = this.db
      .query(
        `INSERT INTO gate_results (workitem_id, name, status, exit_code, duration_ms, output)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(g.workItemId, g.name, g.status, g.exitCode, g.durationMs, g.output) as { id: number };
    return { ...g, id: row.id };
  }

  getGate(id: number): GateResult | null {
    const r = this.db.query("SELECT * FROM gate_results WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: r.id as number,
      workItemId: r.workitem_id as string,
      name: r.name as string,
      status: r.status as GateResult["status"],
      exitCode: r.exit_code as number,
      durationMs: r.duration_ms as number,
      output: r.output as string,
    };
  }

  // ---- Testsperre ------------------------------------------------------------------

  saveLock(workItemId: string, files: string[], hash: string): void {
    this.db
      .query("INSERT OR REPLACE INTO acceptance_locks (workitem_id, files, hash, locked_at) VALUES (?, ?, ?, ?)")
      .run(workItemId, JSON.stringify(files), hash, new Date().toISOString());
  }

  getLock(workItemId: string): { files: string[]; hash: string } | null {
    const r = this.db.query("SELECT * FROM acceptance_locks WHERE workitem_id = ?").get(workItemId) as Record<
      string,
      unknown
    > | null;
    return r ? { files: JSON.parse(r.files as string), hash: r.hash as string } : null;
  }

  // ---- Freigaben -------------------------------------------------------------------

  createApproval(workItemId: string, kind: string, context: unknown): Approval {
    const row = this.db
      .query("INSERT INTO approvals (workitem_id, kind, context, status) VALUES (?, ?, ?, 'pending') RETURNING id")
      .get(workItemId, kind, JSON.stringify(context)) as { id: number };
    return this.getApproval(row.id)!;
  }

  resolveApproval(id: number, granted: boolean, note?: string): void {
    this.db.query("UPDATE approvals SET status = ?, note = ? WHERE id = ?").run(granted ? "granted" : "denied", note ?? null, id);
  }

  getApproval(id: number): Approval | null {
    const r = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: r.id as number,
      workItemId: r.workitem_id as string,
      kind: r.kind as string,
      context: JSON.parse(r.context as string),
      status: r.status as Approval["status"],
      note: (r.note as string | null) ?? null,
    };
  }

  pendingApprovals(): Approval[] {
    const ids = this.db.query("SELECT id FROM approvals WHERE status = 'pending' ORDER BY id").all() as { id: number }[];
    return ids.map((r) => this.getApproval(r.id)!);
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
