import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { UsacEvent } from "@usac/shared";
import { proposeInstinct } from "./instincts";
import { addEntry, verifyEntry } from "./memory";
import type { PhaseContext } from "./phases";
import { PRECISION_RULES } from "./prompts";
import { resolveModel } from "./routing";
import type { WorkItem } from "./store";

/**
 * Retrospektive nach Lauf-Ende: nur wenn der Auftrag Probleme hatte, fragt der Code den Learner
 * nach hoechstens 3 Instinct- und 5 Memory-Vorschlaegen. Instincts werden nie automatisch aktiv
 * (Freigabe `instinct`); Memory-Vorschlaege bleiben `proposed`, bis ihre Zitate mechanisch stimmen.
 */

/** Ereignistypen, die eine Retrospektive ausloesen. */
export const PROBLEM_EVENTS: readonly string[] = ["workitem.escalated", "anticheat.violation", "review.changes_requested"];
/** So viele Problem-Ereignisse gehen hoechstens in den Learner-Prompt. */
const MAX_EVENTS_IN_PROMPT = 30;
const MAX_EVENT_DATA = 800;

function isProblem(e: UsacEvent): boolean {
  if (PROBLEM_EVENTS.includes(e.type)) return true;
  // Implementer-Fehlversuch: fehlgeschlagene Session der Rolle implementer.
  const d = e.data as { role?: string; ok?: boolean } | null;
  return e.type === "run.finished" && d?.role === "implementer" && d.ok === false;
}

function implFailures(wi: WorkItem, ctx: PhaseContext): number {
  const n = (ctx.state(wi) as { implFailures?: unknown }).implFailures;
  return typeof n === "number" && n > 0 ? n : 0;
}

function learnerPrompt(wi: WorkItem, problems: UsacEvent[], failures: number): string {
  const lines = problems.slice(-MAX_EVENTS_IN_PROMPT).map((e) => {
    const data = JSON.stringify(e.data ?? {});
    return `- #${e.id} ${e.type}: ${data.length > MAX_EVENT_DATA ? `${data.slice(0, MAX_EVENT_DATA)}...` : data}`;
  });
  return [
    `Auftrag (retrospektive): "${wi.title}" (${wi.type}, ${wi.id}) hatte Probleme. Leite daraus wiederverwendbare Lehren ab. Du aenderst keine Dateien.`,
    failures > 0 ? `Fehlversuche des Implementers: ${failures}` : "",
    `Problem-Ereignisse (ID, Typ, Daten):\n${lines.join("\n")}`,
    `Liefere:
- instincts: hoechstens 3 kurze Verhaltensregeln fuer eine Rolle (role), optional mit glob fuer die betroffenen Dateien; event_ids nur aus der Liste oben.
- memory: hoechstens 5 Fakten ueber das Projekt; jeder mit Datei-Beleg (path, lines, woertliches quote).
- Keine Lehre ohne Beleg. Lieber nichts vorschlagen als raten.`,
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runRetrospective(wi: WorkItem, ctx: PhaseContext, memory: Database): Promise<void> {
  const events = ctx.store.events({ traceId: wi.id });
  const problems = events.filter(isProblem);
  const failures = implFailures(wi, ctx);
  if (problems.length === 0 && failures === 0) {
    ctx.emit(wi, "retro.skipped", { reason: "keine Probleme im Lauf" });
    return;
  }

  const route = resolveModel(ctx.routing, "learner", { budgetUsed: ctx.budgetUsed(), available: ctx.available });
  const res = await ctx.runRole(wi, "learner", route.model, learnerPrompt(wi, problems, failures));
  if (!res.ok) {
    // Die Retrospektive aendert nie den Ausgang des Auftrags.
    ctx.emit(wi, "retro.failed", { model: route.model, feedback: res.feedback.slice(0, 1500) });
    return;
  }
  const out = res.output;

  // Belege eines Instincts muessen Ereignisse dieses Auftrags sein.
  const own = new Set(events.map((e) => e.id));
  for (const p of out.instincts) {
    try {
      const id = proposeInstinct(memory, p, (eid) => own.has(eid));
      const approval = ctx.store.createApproval(wi.id, "instinct", { instinct_id: id, text: p.text, role: p.role, glob: p.glob ?? null, event_ids: p.event_ids });
      ctx.emit(wi, "instinct.proposed", { instinct_id: id, approval_id: approval.id, role: p.role, glob: p.glob ?? null, text: p.text });
      ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "instinct" });
    } catch (err) {
      ctx.emit(wi, "instinct.rejected", { text: p.text, role: p.role, reason: (err as Error).message });
    }
  }

  const root = wi.worktree && existsSync(wi.worktree) ? wi.worktree : wi.projectPath;
  for (const m of out.memory) {
    try {
      const id = addEntry(memory, {
        kind: m.kind,
        text: m.text,
        evidence: m.evidence.map((e) => ({ file: e.path, lines: e.lines[0] === e.lines[1] ? `${e.lines[0]}` : `${e.lines[0]}-${e.lines[1]}`, quote: e.quote })),
      });
      let verified = false;
      try {
        verified = verifyEntry(memory, id, root);
      } catch {
        verified = false; // Beleg ausserhalb des Projekts: bleibt proposed.
      }
      ctx.emit(wi, "memory.proposed", { entry_id: id, kind: m.kind, text: m.text, status: verified ? "verified" : "proposed" });
    } catch (err) {
      ctx.emit(wi, "memory.rejected", { kind: m.kind, text: m.text, reason: (err as Error).message });
    }
  }
  ctx.emit(wi, "retro.finished", { model: route.model, instincts: out.instincts.length, memory: out.memory.length });
}
