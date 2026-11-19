// Metriken aus dem Event-Log (Phase 5, ADR 0010).
// Reine Funktion: eine Schleife ueber die nach id sortierten Events, Gruppierung nach traceId (= Work-Item-ID).
import type { Model, UsacEvent } from "../../shared/src/index";

export type PeriodMetrics = {
  start: string;
  end: string;
  done: number;
  escalated: number;
  failed: number;
  escalationRate: number;
  tokens: number;
};

export type RoleModelStats = {
  role: string;
  model: Model;
  runs: number;
  okRuns: number;
  firstPassRate: number;
  escalations: number;
  tokens: number;
  avgTurns: number;
};

export type ApprovalWait = { kind: string; count: number; medianMs: number; maxMs: number };

export type Metrics = {
  periods: PeriodMetrics[];
  failuresPerItem: { workItemId: string; failures: number }[];
  roles: RoleModelStats[];
  approvalWait: ApprovalWait[];
};

export type MetricsOptions = { periodStart: Date; periodDays: number; now: Date };

const DAY_MS = 86_400_000;
/** Ereignisse, die eine offene Freigabe abschliessen (der Code schreibt granted/denied, die Spec nennt resolved). */
const APPROVAL_RESOLVED = new Set(["approval.resolved", "approval.granted", "approval.denied"]);

type Session = { role: string; model: Model; spanId: string; ok: boolean; firstPass: boolean };

type RoleAcc = { role: string; model: Model; runs: number; okRuns: number; firstTries: number; firstPasses: number; escalations: number; tokens: number; turns: number };

type TraceAcc = {
  implementerStarts: number;
  green: boolean;
  lastRun?: { role: string; model: Model };
  /** Erste Session je Rolle; offen, solange die Rolle in diesem Auftrag keine zweite Session gestartet hat. */
  first: Map<string, Session & { open: boolean; greenSince: boolean }>;
};

function tokensOf(data: Record<string, unknown>): number {
  const t = data.tokens as { input?: number; output?: number } | undefined;
  return (Number(t?.input) || 0) + (Number(t?.output) || 0);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function computeMetrics(events: UsacEvent[], opts: MetricsOptions): Metrics {
  const sorted = [...events].sort((a, b) => a.id - b.id);
  if (!sorted.length) return { periods: [], failuresPerItem: [], roles: [], approvalWait: [] };

  const startMs = opts.periodStart.getTime();
  const boxMs = Math.max(1, opts.periodDays) * DAY_MS;
  const periodIndex = (ts: string): number => {
    const t = Date.parse(ts);
    return Number.isNaN(t) || t < startMs ? -1 : Math.floor((t - startMs) / boxMs);
  };
  // Zeitraeume vom Start bis zum Zeitraum, der `now` (oder das letzte Event) enthaelt, lueckenlos.
  let lastIndex = Math.max(-1, periodIndex(opts.now.toISOString()));
  for (const e of sorted) lastIndex = Math.max(lastIndex, periodIndex(e.ts));
  const periods: PeriodMetrics[] = [];
  for (let i = 0; i <= lastIndex; i++) {
    periods.push({
      start: new Date(startMs + i * boxMs).toISOString(),
      end: new Date(startMs + (i + 1) * boxMs).toISOString(),
      done: 0,
      escalated: 0,
      failed: 0,
      escalationRate: 0,
      tokens: 0,
    });
  }

  const traces = new Map<string, TraceAcc>();
  const traceOrder: string[] = [];
  const roles = new Map<string, RoleAcc>();
  const roleOrder: string[] = [];
  const openApprovals = new Map<string, { kind: string; ts: number }>();
  const waits = new Map<string, number[]>();
  const waitOrder: string[] = [];

  const trace = (id: string): TraceAcc => {
    let t = traces.get(id);
    if (!t) {
      t = { implementerStarts: 0, green: false, first: new Map() };
      traces.set(id, t);
      traceOrder.push(id);
    }
    return t;
  };
  const roleAcc = (role: string, model: Model): RoleAcc => {
    const key = `${role}\u0000${model}`;
    let r = roles.get(key);
    if (!r) {
      r = { role, model, runs: 0, okRuns: 0, firstTries: 0, firstPasses: 0, escalations: 0, tokens: 0, turns: 0 };
      roles.set(key, r);
      roleOrder.push(key);
    }
    return r;
  };
  /** Erste Session einer Rolle gilt als gescheitert, solange ihr Fenster offen ist. */
  const failFirst = (t: TraceAcc, role: string | undefined, spanId: string | undefined) => {
    for (const s of t.first.values()) {
      if (!s.open) continue;
      if ((role && s.role === role) || (spanId && s.spanId === spanId)) s.firstPass = false;
    }
  };

  for (const e of sorted) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const idx = periodIndex(e.ts);
    const period = idx >= 0 ? periods[idx] : undefined;
    const t = trace(e.traceId);

    switch (e.type) {
      case "workitem.done":
        if (period) period.done++;
        break;
      case "workitem.failed":
        if (period) period.failed++;
        break;
      case "workitem.escalated":
        if (period) period.escalated++;
        if (t.lastRun) roleAcc(t.lastRun.role, t.lastRun.model).escalations++;
        break;
      case "run.started": {
        const role = String(data.role ?? "");
        if (role === "implementer") t.implementerStarts++;
        // Eine zweite Session derselben Rolle schliesst das Fenster der ersten.
        const first = t.first.get(role);
        if (first) first.open = false;
        break;
      }
      case "run.finished": {
        const role = String(data.role ?? "");
        const model = String(data.model ?? "") as Model;
        const ok = data.ok === true;
        const tokens = tokensOf(data);
        const acc = roleAcc(role, model);
        acc.runs++;
        if (ok) acc.okRuns++;
        acc.tokens += tokens;
        acc.turns += Number(data.turns) || 0;
        if (period) period.tokens += tokens;
        t.lastRun = { role, model };
        if (!t.first.has(role)) t.first.set(role, { role, model, spanId: e.spanId, ok, firstPass: ok, open: true, greenSince: false });
        break;
      }
      case "output.invalid":
      case "evidence.invalid":
        failFirst(t, data.role === undefined ? undefined : String(data.role), e.spanId);
        break;
      case "review.changes_requested":
        // Review-Aenderungen betreffen die Implementierung, nicht Analyse oder Tests.
        failFirst(t, "implementer", undefined);
        break;
      case "gate.failed": {
        const s = t.first.get("implementer");
        if (s?.open && !s.greenSince) s.firstPass = false;
        break;
      }
      case "acceptance.green": {
        t.green = true;
        const s = t.first.get("implementer");
        if (s?.open) s.greenSince = true;
        break;
      }
      case "approval.requested": {
        if (data.approval_id === undefined) break;
        openApprovals.set(String(data.approval_id), { kind: String(data.kind ?? "unknown"), ts: Date.parse(e.ts) });
        break;
      }
      default:
        if (APPROVAL_RESOLVED.has(e.type) && data.approval_id !== undefined) {
          const id = String(data.approval_id);
          const open = openApprovals.get(id);
          if (!open) break;
          openApprovals.delete(id);
          const ms = Date.parse(e.ts) - open.ts;
          if (Number.isNaN(ms)) break;
          if (!waits.has(open.kind)) {
            waits.set(open.kind, []);
            waitOrder.push(open.kind);
          }
          waits.get(open.kind)!.push(Math.max(0, ms));
        }
    }
  }

  for (const s of periods) {
    const closed = s.done + s.escalated + s.failed;
    s.escalationRate = closed ? s.escalated / closed : 0;
  }

  for (const id of traceOrder) {
    for (const s of traces.get(id)!.first.values()) {
      const acc = roleAcc(s.role, s.model);
      acc.firstTries++;
      if (s.firstPass) acc.firstPasses++;
    }
  }

  const failuresPerItem = traceOrder
    .map((id) => ({ id, t: traces.get(id)! }))
    .filter(({ t }) => t.implementerStarts > 0)
    .map(({ id, t }) => ({ workItemId: id, failures: t.green ? t.implementerStarts - 1 : t.implementerStarts }));

  const roleStats: RoleModelStats[] = roleOrder.map((k) => {
    const r = roles.get(k)!;
    return {
      role: r.role,
      model: r.model,
      runs: r.runs,
      okRuns: r.okRuns,
      firstPassRate: r.firstTries ? r.firstPasses / r.firstTries : 0,
      escalations: r.escalations,
      tokens: r.tokens,
      avgTurns: r.runs ? r.turns / r.runs : 0,
    };
  });

  const approvalWait: ApprovalWait[] = waitOrder.map((kind) => {
    const xs = waits.get(kind)!;
    return { kind, count: xs.length, medianMs: median(xs), maxMs: Math.max(...xs) };
  });

  return { periods, failuresPerItem, roles: roleStats, approvalWait };
}
