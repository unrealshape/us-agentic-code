import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnalystOutput, Slice } from "@usac/shared";
import { git } from "./exec";
import { Escalate, type PhaseContext, type PhaseHandler } from "./phases";
import { checkPlan, sliceOrder } from "./plan-check";
import { analystPrompt, techLeadPrompt } from "./prompts";
import { resolveModel } from "./routing";
import type { WorkItem } from "./store";

/** Ort der Spec im Worktree; der Orchestrator schreibt sie aus der Analyst-Ausgabe. */
export const SPEC_PATH = "spec/feature.md";
/** Versuche des Analysten je Spec-Runde (ungueltige Ausgabe zaehlt als Fehlversuch). */
export const SPEC_ATTEMPTS = 2;
/** Versuche des Tech Leads, einen mechanisch gueltigen Plan zu liefern. */
export const PLAN_ATTEMPTS = 2;
/** Hoechstzahl an Spec-Runden; die dritte Ablehnung eskaliert. */
export const SPEC_ROUNDS = 3;

const DENIED_WITHOUT_NOTE = "Spec abgelehnt ohne Begründung. Stelle Rückfragen zu dem, was unklar ist.";

type FeatureState = {
  phase: string;
  spec?: AnalystOutput;
  specApprovalId?: number;
  specRounds?: number;
  specFeedback?: string;
  slices?: Slice[];
  sliceOrder?: string[];
};

const st = (ctx: PhaseContext, wi: WorkItem) => ctx.state(wi) as FeatureState;

/** Eine Zeile je Feld: Zeilenumbrueche wuerden das Markdown-Geruest zerbrechen. */
const line = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

const list = (items: string[]) => (items.length ? items.map((i) => `- ${line(i)}`).join("\n") : "- keine");

/** Erzeugt spec/feature.md deterministisch aus der Analyst-Ausgabe. */
export function renderSpec(wi: WorkItem, out: AnalystOutput): string {
  const criteria = out.criteria
    .map((c) => `- **${c.id}** (${c.source}): Gegeben ${line(c.given)}, wenn ${line(c.when)}, dann ${line(c.then)}`)
    .join("\n");
  return [
    `# Spec: ${line(out.title)}`,
    `Usac-Trace: ${wi.id}`,
    line(out.summary),
    `## Akzeptanzkriterien\n\n${criteria}`,
    `## Nicht im Umfang\n\n${list(out.out_of_scope)}`,
    `## Offene Fragen\n\n${list(out.questions)}`,
  ].join("\n\n") + "\n";
}

export function createFeatureHandlers(): { spec: PhaseHandler; approve_spec: PhaseHandler; plan: PhaseHandler } {
  const spec: PhaseHandler = async (wi, ctx) => {
    const s = st(ctx, wi);
    if (s.spec) return wi; // Resume: Spec steht schon
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= SPEC_ATTEMPTS; attempt++) {
      const route = resolveModel(ctx.routing, "analyst", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
      // Notiz der Ablehnung bleibt erhalten, auch wenn ein Schema-Fehler hinzukommt.
      const fb = [s.specFeedback, feedback].filter(Boolean).join("\n\n") || undefined;
      const res = await ctx.runRole(wi, "analyst", route.model, analystPrompt(wi, fb));
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const path = join(wi.worktree!, SPEC_PATH);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderSpec(wi, res.output));
      ctx.emit(wi, "spec.written", { path: SPEC_PATH, criteria: res.output.criteria.map((c) => c.id), questions: res.output.questions });
      return ctx.save(wi, { spec: res.output });
    }
    throw new Escalate(`Keine gültige Spec nach ${SPEC_ATTEMPTS} Versuchen`);
  };

  const approve_spec: PhaseHandler = async (wi, ctx) => {
    const { store } = ctx;
    const s = st(ctx, wi);
    const out = s.spec;
    if (!out) throw new Error("approve_spec ohne Spec im Zustand");
    let approval = s.specApprovalId ? store.getApproval(s.specApprovalId) : null;
    if (!approval) {
      approval = store.createApproval(wi.id, "spec", { path: SPEC_PATH, criteria: out.criteria, questions: out.questions });
      ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "spec", path: SPEC_PATH, questions: out.questions.length });
      wi = ctx.save(wi, { specApprovalId: approval.id });
      // Offene Fragen brauchen immer einen Menschen.
      if (ctx.autoApprovals.has("spec") && out.questions.length === 0) {
        store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
        approval = store.getApproval(approval.id)!;
      }
    }
    if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
    if (approval.status === "denied") {
      const round = (s.specRounds ?? 0) + 1;
      ctx.emit(wi, "spec.denied", { approval_id: approval.id, round, note: approval.note });
      if (round >= SPEC_ROUNDS) throw new Escalate(`Spec ${round}-mal abgelehnt: ${approval.note ?? ""}`);
      return ctx.save(
        wi,
        { phase: "spec", spec: undefined, specApprovalId: undefined, specRounds: round, specFeedback: approval.note || DENIED_WITHOUT_NOTE },
        { status: "running" },
      );
    }
    ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "spec" });
    await git(wi.worktree!, "add", "--", SPEC_PATH);
    // Wiedereintritt nach Absturz zwischen Commit und Phasenwechsel: nichts vorgemerkt heisst,
    // die Spec ist schon committet. Dann den vorhandenen Commit nehmen statt erneut zu committen.
    const staged = await git(wi.worktree!, "diff", "--cached", "--name-only", "--", SPEC_PATH);
    const sha = staged
      ? await ctx.commit(wi.worktree!, `docs: Spec für "${line(out.title)}"\n\nUsac-Trace: ${wi.id}`)
      : await git(wi.worktree!, "log", "-1", "--format=%H", "--", SPEC_PATH);
    if (!sha) throw new Error(`${SPEC_PATH} fehlt im Worktree und in der Historie`);
    ctx.emit(wi, "spec.committed", { path: SPEC_PATH, commit: sha, ...(staged ? {} : { reused: true }) });
    return ctx.save(wi, { specFeedback: undefined }, { status: "running" });
  };

  const plan: PhaseHandler = async (wi, ctx) => {
    const s = st(ctx, wi);
    if (s.slices) return wi; // Resume: Plan steht schon
    if (!s.spec) throw new Error("plan ohne Spec im Zustand");
    const ids = s.spec.criteria.map((c) => c.id);
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
      const route = resolveModel(ctx.routing, "tech-lead", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
      const res = await ctx.runRole(wi, "tech-lead", route.model, techLeadPrompt(wi, s.spec, feedback));
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const checked = checkPlan(ids, res.output, ctx.gateProfile);
      if (checked.errors.length) {
        ctx.emit(wi, "plan.invalid", { errors: checked.errors });
        feedback = `Der Plan ist ungültig:\n${checked.errors.map((e) => `- ${e}`).join("\n")}`;
        continue;
      }
      const order = sliceOrder(checked.plan.slices);
      // Eine Nutzerangabe zur Groesse gewinnt; nur die Standardgroesse wird ersetzt.
      const first = ctx.store.events({ traceId: wi.id, type: "workitem.classified", limit: 1 })[0];
      if ((first?.data as { by?: string } | undefined)?.by === "default") {
        ctx.store.updateWorkItem(wi.id, { size: checked.plan.size });
        wi = ctx.store.getWorkItem(wi.id)!;
        ctx.emit(wi, "workitem.classified", { size: checked.plan.size, by: "tech-lead" });
      }
      ctx.emit(wi, "plan.created", { slices: checked.plan.slices.map((x) => x.id), order });
      return ctx.save(wi, { slices: checked.plan.slices, sliceOrder: order });
    }
    throw new Escalate(`Kein gültiger Plan nach ${PLAN_ATTEMPTS} Versuchen`);
  };

  return { spec, approve_spec, plan };
}
