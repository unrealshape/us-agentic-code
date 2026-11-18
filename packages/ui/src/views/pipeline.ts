import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Model, UsacEvent } from "../../../shared/src/index";
import type { Store, WorkItem } from "../../../daemon/src/store";
import { loadProjectProfile } from "../../../daemon/src/config";
import { activePhases, loadWorkflow, type Workflow } from "../../../daemon/src/workflow";
import { esc, page } from "../html";

export type PipelineStatus = "done" | "current" | "pending" | "skipped" | "failed";

export type PipelineNode = {
  name: string;
  status: PipelineStatus;
  role?: string;
  model?: Model;
  attempts: number;
  durationMs?: number;
};

export type PipelineData = { workItemId: string; workflow: string; nodes: PipelineNode[] };

const STATUS_TEXT: Record<PipelineStatus, string> = {
  done: "erledigt",
  current: "aktiv",
  pending: "offen",
  skipped: "übersprungen",
  failed: "fehlgeschlagen",
};

/** Wie im Orchestrator: Typen ohne eigene Workflow-Datei laufen als bugfix. */
function workflowFor(pluginRoot: string, type: string): Workflow {
  const own = join(pluginRoot, "workflows", `${type}.yaml`);
  return loadWorkflow(existsSync(own) ? own : join(pluginRoot, "workflows", "bugfix.yaml"));
}

/**
 * Phasen, deren `when` fuer Auftrag und Projekt nicht zutrifft. Ohne lesbares Projektprofil
 * bleibt die Menge leer; dann zaehlen nur `phase.skipped`-Events.
 */
function inactivePhases(wf: Workflow, wi: WorkItem): Set<string> {
  let profile;
  try {
    profile = loadProjectProfile(wi.projectPath);
  } catch {
    return new Set();
  }
  const active = new Set(activePhases(wf, wi, profile).map((p) => p.name));
  return new Set(wf.phases.map((p) => p.name).filter((n) => !active.has(n)));
}

const TERMINAL = new Set(["workitem.done", "workitem.escalated", "workitem.failed"]);

/**
 * Leitet den Zustand jeder Workflow-Phase aus Work-Item und Event-Log ab (deterministisch, ohne LLM).
 * - `current`: zuletzt betretene Phase (`phase.entered`), sonst `state.phase` des Auftrags.
 * - `done`: alle Phasen vor `current`; bei erledigtem Auftrag alle nicht uebersprungenen.
 * - `skipped`: `phase.skipped` ohne spaeteres `phase.entered`, oder `when` trifft nicht zu.
 * - `failed`: Phase aus `workitem.escalated`/`workitem.failed`, wenn danach keine Phase mehr betreten wurde.
 * - `attempts`/`model`: `run.started` mit der Rolle der Phase; Modell aus dem letzten.
 * - `durationMs`: Summe der Zeiten von `phase.entered` bis zum naechsten Phasenwechsel bzw. Abschluss.
 */
export function pipelineData(store: Store, pluginRoot: string, workItemId: string): PipelineData | null {
  const wi = store.getWorkItem(workItemId);
  if (!wi) return null;
  const wf = workflowFor(pluginRoot, wi.type);
  const events = store.events({ traceId: workItemId });
  const names = new Set(wf.phases.map((p) => p.name));
  const nameOf = (e: UsacEvent) => String((e.data as { name?: unknown }).name ?? "");

  // Letzte Markierung je Phase: ein spaeteres phase.entered hebt ein phase.skipped auf.
  const mark = new Map<string, "entered" | "skipped">();
  let current: string | undefined;
  let lastEnteredId = -1;
  for (const e of events) {
    if (e.type === "phase.entered") {
      mark.set(nameOf(e), "entered");
      current = nameOf(e);
      lastEnteredId = e.id;
    } else if (e.type === "phase.skipped") {
      mark.set(nameOf(e), "skipped");
    }
  }
  const statePhase = (wi.state as { phase?: unknown }).phase;
  if (current === undefined && typeof statePhase === "string" && names.has(statePhase)) current = statePhase;
  const allDone = wi.status === "done" || statePhase === "done";

  let failedPhase: string | undefined;
  for (const e of events) {
    if ((e.type === "workitem.escalated" || e.type === "workitem.failed") && e.id > lastEnteredId) {
      const p = (e.data as { phase?: unknown }).phase;
      failedPhase = typeof p === "string" ? p : current;
    }
  }

  // Verweildauer je Phase.
  const duration = new Map<string, number>();
  let open: { name: string; ts: number } | undefined;
  for (const e of events) {
    if (e.type !== "phase.entered" && !TERMINAL.has(e.type)) continue;
    const ts = Date.parse(e.ts);
    if (open && Number.isFinite(ts) && Number.isFinite(open.ts)) {
      duration.set(open.name, (duration.get(open.name) ?? 0) + Math.max(0, ts - open.ts));
    }
    open = e.type === "phase.entered" ? { name: nameOf(e), ts } : undefined;
  }

  const inactive = inactivePhases(wf, wi);
  const curIdx = current === undefined ? -1 : wf.phases.findIndex((p) => p.name === current);
  const runs = events.filter((e) => e.type === "run.started");

  const nodes = wf.phases.map((p, i): PipelineNode => {
    let status: PipelineStatus;
    const m = mark.get(p.name);
    if (m === "skipped" || (m === undefined && inactive.has(p.name))) status = "skipped";
    else if (p.name === failedPhase) status = "failed";
    else if (allDone || i < curIdx) status = "done";
    else if (i === curIdx) status = "current";
    else status = "pending";

    const node: PipelineNode = { name: p.name, status, attempts: 0 };
    if (p.role) {
      node.role = p.role;
      const own = runs.filter((e) => (e.data as { role?: unknown }).role === p.role);
      node.attempts = own.length;
      const model = (own.at(-1)?.data as { model?: unknown } | undefined)?.model;
      if (typeof model === "string") node.model = model as Model;
    }
    const d = duration.get(p.name);
    if (d !== undefined) node.durationMs = d;
    return node;
  });
  return { workItemId, workflow: wf.name, nodes };
}

const NODE_W = 140;
const NODE_H = 70;
const GAP_X = 24;
const GAP_Y = 30;
const PER_ROW = 8;
const PAD = 10;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Pipeline als SVG: Knoten waagrecht, Umbruch nach 8. Der Status steht als Klasse `st-<status>`
 * und zusaetzlich als Text im Knoten, damit er nicht nur an der Farbe haengt.
 */
export function pipelineSvg(nodes: PipelineNode[]): string {
  const cols = Math.min(PER_ROW, Math.max(1, nodes.length));
  const rows = Math.max(1, Math.ceil(nodes.length / PER_ROW));
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y;
  const pos = (i: number) => ({
    x: PAD + (i % PER_ROW) * (NODE_W + GAP_X),
    y: PAD + Math.floor(i / PER_ROW) * (NODE_H + GAP_Y),
  });

  const edges: string[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = pos(i - 1);
    const b = pos(i);
    if (a.y === b.y) {
      edges.push(`<line class="edge" x1="${a.x + NODE_W}" y1="${a.y + NODE_H / 2}" x2="${b.x}" y2="${b.y + NODE_H / 2}"/>`);
    } else {
      // Zeilenumbruch: vom Ende der Zeile zurueck zum Anfang der naechsten.
      const midY = a.y + NODE_H + GAP_Y / 2;
      edges.push(
        `<polyline class="edge" fill="none" points="${a.x + NODE_W / 2},${a.y + NODE_H} ${a.x + NODE_W / 2},${midY} ${b.x + NODE_W / 2},${midY} ${b.x + NODE_W / 2},${b.y}"/>`,
      );
    }
  }

  const body = nodes
    .map((n, i) => {
      const { x, y } = pos(i);
      const label = STATUS_TEXT[n.status];
      const detail = [
        n.role,
        n.attempts > 0 ? `${n.attempts}x${n.model ? ` ${n.model}` : ""}` : undefined,
        n.durationMs !== undefined ? fmtDuration(n.durationMs) : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      const tip = `${n.name}: ${label}${detail ? ` (${detail})` : ""}`;
      return (
        `<g class="node st-${n.status}" transform="translate(${x},${y})">` +
        `<title>${esc(tip)}</title>` +
        `<rect width="${NODE_W}" height="${NODE_H}" rx="8"/>` +
        `<text class="name" x="10" y="22">${esc(n.name)}</text>` +
        `<text class="status" x="10" y="42">${esc(label)}</text>` +
        (detail ? `<text class="detail" x="10" y="60">${esc(detail)}</text>` : "") +
        `</g>`
      );
    })
    .join("");

  return (
    `<svg class="pipeline" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pipeline" ` +
    `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${edges.join("")}${body}</svg>`
  );
}

const STYLE = `<style>
.pipeline .edge{stroke:#888;stroke-width:2}
.pipeline rect{fill:#fff;stroke:#888;stroke-width:2}
.pipeline text{font:12px sans-serif;fill:#222}
.pipeline .name{font-weight:bold}
.pipeline .st-done rect{fill:#e3f4e1;stroke:#2e7d32}
.pipeline .st-current rect{fill:#e3ecfa;stroke:#1565c0;stroke-width:3}
.pipeline .st-pending rect{fill:#f5f5f5}
.pipeline .st-skipped rect{fill:#fafafa;stroke-dasharray:4 3}
.pipeline .st-skipped text{fill:#777}
.pipeline .st-failed rect{fill:#fde7e7;stroke:#c62828;stroke-width:3}
</style>`;

export function pipelineHtml(store: Store, pluginRoot: string, id: string): string {
  const data = pipelineData(store, pluginRoot, id);
  if (!data) return page("Pipeline", `<h1>Pipeline</h1><p>Unbekannter Auftrag: ${esc(id)}</p>`);
  const wi = store.getWorkItem(id)!;
  const rows = data.nodes
    .map(
      (n) =>
        `<tr class="st-${n.status}"><td>${esc(n.name)}</td><td>${esc(STATUS_TEXT[n.status])}</td>` +
        `<td>${esc(n.role ?? "")}</td><td>${n.attempts}</td><td>${esc(n.model ?? "")}</td>` +
        `<td>${n.durationMs !== undefined ? esc(fmtDuration(n.durationMs)) : ""}</td></tr>`,
    )
    .join("");
  return page(
    `Pipeline ${id}`,
    `${STYLE}<h1>Pipeline ${esc(id)}</h1>` +
      `<p>${esc(wi.title)} · Workflow ${esc(data.workflow)} · Status ${esc(wi.status)} · ` +
      `<a href="/runs/${encodeURIComponent(id)}">Event-Log</a></p>` +
      pipelineSvg(data.nodes) +
      `<table><thead><tr><th>Phase</th><th>Status</th><th>Rolle</th><th>Versuche</th><th>Modell</th><th>Dauer</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
  );
}
