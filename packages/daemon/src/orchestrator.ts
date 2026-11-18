import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { ROLE_OUTPUTS, type Model, type RoleWithOutput, type Size, type WorkItemType } from "@usac/shared";
import { loadGateProfile, loadProjectProfile, matchesAny, type GateProfile, type ProjectProfile } from "./config";
import { ContextBudget } from "./budget";
import { git } from "./exec";
import { excludeFromGit, hasGraphify, updateGraph } from "./graph";
import { validateClaims, validateFindings, type EvidenceError } from "./evidence";
import { runAcceptance, runStages, summarize } from "./gates";
import { changedFiles, checkImplementerDiff, hashFiles, revertPaths } from "./integrity";
import { Escalate, getPhase, missingPhases, registerPhase, type Actor, type PhaseContext, type PhaseLimits } from "./phases";
import { GRAPH_NOTE, implementerPrompt, reviewerPrompt, rolePrompt, roleSchema, testEngineerPrompt } from "./prompts";
import { budgetUsedFraction, DEFAULT_MAX_TOKENS } from "./quota";
import { loadRouting, resolveModel, type RoutingConfig } from "./routing";
import type { Runner } from "./runner/types";
import type { GateResult, Store, WorkItem } from "./store";
import { loadWorkflow, type PhaseSpec, type Workflow } from "./workflow";

export { Escalate } from "./phases";

export interface OrchestratorOptions {
  store: Store;
  runner: Runner;
  /** Wurzel des Plugins (agents/, schemas/, routing.yaml, gate-profiles/, workflows/). */
  pluginRoot: string;
  /** ~/.usac oder ein Testordner; dort liegen Worktrees. */
  home: string;
  approvals?: { auto?: string[] };
  /** Anteil des verbrauchten Kontingents (0..1). Standard: Schaetzung aus run.finished-Events (quota.ts). */
  budgetUsed?: () => number;
  /** Parameter der Standard-Schaetzung des Kontingents. */
  quota?: { maxTokens?: number; windowMs?: number };
  /** Im Abo verfuegbare Modelle. */
  available?: Model[];
  limits?: Partial<Limits>;
  urlAllowlist?: string[];
  /** Graphify-Graph im Worktree aufbauen (Standard: ja, wenn installiert). */
  graphify?: boolean;
}

type Limits = PhaseLimits;

const DEFAULT_LIMITS: Limits = {
  acceptanceAttempts: 2,
  implementAttempts: 6,
  reviewAttempts: 3,
  maxTurns: 60,
  runTimeoutMs: 20 * 60_000,
};

/** Hoechstzahl an Phasenschritten je `run`-Aufruf; schuetzt vor Handlern, die endlos springen. */
const MAX_PHASE_STEPS = 200;

/** Zeitfenster der Kontingent-Schaetzung (Annahme: Wochenlimit des Abos; siehe Bericht Task 4). */
const DEFAULT_QUOTA_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface SubmitInput {
  projectPath: string;
  type: WorkItemType;
  title: string;
  description: string;
  size?: Size;
}

export interface RunResult {
  status: WorkItem["status"];
  branch: string | null;
  reason?: string;
}

/** Zustand der Phase-0-Handler. `phase` ist ein Phasenname aus der Workflow-Datei oder "done". */
type State = {
  phase: string;
  acceptanceFiles?: string[];
  baseRef?: string;
  h1ApprovalId?: number;
  implFailures?: number;
  lastFailure?: string;
  lastImplModel?: Model;
  reviewFeedback?: string;
};

const st = (ctx: PhaseContext, wi: WorkItem) => ctx.state(wi) as State;

// ---- Eingebaute Phasen ------------------------------------------------------------------
// Ein Handler laesst `phase` unveraendert, um zur naechsten Phase der Workflow-Datei zu gehen
// (Vertrag siehe PhaseContext in phases.ts).

registerPhase("setup", async (wi, ctx) => {
  const { profile, home } = ctx;
  const branch = `usac/${wi.id}`;
  const dir = join(home, "worktrees", profile.name, wi.id);
  mkdirSync(join(home, "worktrees", profile.name), { recursive: true });
  if (!existsSync(dir)) await git(wi.projectPath, "worktree", "add", "-q", "-b", branch, dir, profile.base_branch);
  // Erzeugte Artefakte gehoeren nie in einen Commit.
  await excludeFromGit(dir, ["graphify-out/", "luacov.stats.out", "luacov.report.out"]);
  wi = ctx.save(wi, {}, { branch, worktree: dir });
  ctx.emit(wi, "worktree.created", { branch, path: dir, base: profile.base_branch });
  if (ctx.graphify !== false && (await hasGraphify())) {
    const g = await updateGraph(dir);
    ctx.emit(wi, g.ok ? "graph.updated" : "graph.failed", { nodes: g.nodes, edges: g.edges, output: g.ok ? undefined : g.output });
  } else {
    ctx.emit(wi, "graph.skipped", { reason: ctx.graphify === false ? "abgeschaltet" : "graphify nicht installiert" });
  }
  return wi;
});

registerPhase("acceptance", async (wi, ctx) => {
  const gp = ctx.gateProfile;
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= ctx.limits.acceptanceAttempts; attempt++) {
    const base = await git(wi.worktree!, "rev-parse", "HEAD");
    const route = resolveModel(ctx.routing, "test-engineer", {
      variant: ctx.spec.variant ?? "acceptance",
      size: wi.size,
      budgetUsed: ctx.budgetUsed(),
      available: ctx.available,
    });
    const res = await ctx.runRole(wi, "test-engineer", route.model, testEngineerPrompt(wi, feedback));
    if (!res.ok) {
      feedback = res.feedback;
      continue;
    }
    const files = res.output.acceptance_tests;
    // Der Test Engineer darf nur Testdateien anfassen.
    const nonTest = (await changedFiles(wi.worktree!, base)).filter((p) => !matchesAny(p, gp.test_globs));
    const missing = files.filter((f) => !existsSync(join(wi.worktree!, f)) || !matchesAny(f, gp.test_globs));
    if (nonTest.length || missing.length) {
      if (nonTest.length) await revertPaths(wi.worktree!, base, nonTest);
      ctx.emit(wi, "anticheat.violation", { role: "test-engineer", nonTest, missing });
      feedback = `Nur Testdateien sind erlaubt. Verworfen: ${nonTest.join(", ") || "-"}. Fehlende oder ungueltige Testpfade: ${missing.join(", ") || "-"}`;
      continue;
    }
    const gate = await runAcceptance(ctx.store, wi.id, gp, wi.worktree!, files);
    gateEvents(ctx, wi, [gate]);
    if (gate.status === "passed") {
      ctx.emit(wi, "acceptance.rejected", { reason: "Abnahmetest ist ohne Aenderung schon gruen und beweist nichts", files });
      await revertPaths(wi.worktree!, base, await changedFiles(wi.worktree!, base));
      feedback = "Dein Abnahmetest war sofort gruen. Er muss das fehlende Verhalten beweisen und daher mit dem aktuellen Code rot sein.";
      continue;
    }
    ctx.emit(wi, "acceptance.red", { gate_result_id: gate.id, files });
    return ctx.save(wi, { acceptanceFiles: files });
  }
  throw new Escalate("Kein brauchbarer Abnahmetest nach " + ctx.limits.acceptanceAttempts + " Versuchen");
});

registerPhase("approve_h1", async (wi, ctx) => {
  const { store } = ctx;
  const s = st(ctx, wi);
  let approval = s.h1ApprovalId ? store.getApproval(s.h1ApprovalId) : null;
  if (!approval) {
    approval = store.createApproval(wi.id, "h1", { files: s.acceptanceFiles, title: wi.title });
    ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "h1", files: s.acceptanceFiles });
    wi = ctx.save(wi, { h1ApprovalId: approval.id });
    if (ctx.autoApprovals.has("h1")) {
      store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
      approval = store.getApproval(approval.id)!;
    }
  }
  if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
  if (approval.status === "denied") throw new Escalate(`Abnahmetest abgelehnt: ${approval.note ?? ""}`);
  ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "h1" });
  return ctx.save(wi, {}, { status: "running" });
});

registerPhase("lock", async (wi, ctx) => {
  const files = st(ctx, wi).acceptanceFiles!;
  const hash = hashFiles(wi.worktree!, files);
  ctx.store.saveLock(wi.id, files, hash);
  await git(wi.worktree!, "add", "--", ...files);
  const sha = await ctx.commit(wi.worktree!, `test: Abnahmetest fuer "${wi.title}"\n\nUsac-Trace: ${wi.id}`);
  ctx.emit(wi, "test.locked", { files, hash, commit: sha });
  return ctx.save(wi, { baseRef: sha, implFailures: 0 });
});

registerPhase("implement", async (wi, ctx) => {
  const gp = ctx.gateProfile;
  let s = st(ctx, wi);
  const lockInfo = ctx.store.getLock(wi.id)!;
  while ((s.implFailures ?? 0) < ctx.limits.implementAttempts) {
    const failures = s.implFailures ?? 0;
    const route = resolveModel(ctx.routing, "implementer", { size: wi.size, failures, budgetUsed: ctx.budgetUsed(), available: ctx.available });
    if (s.lastImplModel && s.lastImplModel !== route.model) {
      ctx.emit(wi, "model.escalated", { role: "implementer", from: s.lastImplModel, to: route.model, reasons: route.reasons });
    }
    const res = await ctx.runRole(wi, "implementer", route.model, implementerPrompt(wi, lockInfo.files, s.lastFailure));
    let failure: string | null = null;
    if (!res.ok) failure = res.feedback;

    const violations = await checkImplementerDiff(wi.worktree!, s.baseRef!, gp, lockInfo.files);
    if (violations.length) {
      ctx.emit(wi, "anticheat.violation", { role: "implementer", violations });
      await revertPaths(wi.worktree!, s.baseRef!, violations.map((v) => v.path));
      failure = `Verstoesse wurden verworfen: ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}`;
    }
    if (hashFiles(wi.worktree!, lockInfo.files) !== lockInfo.hash) {
      await revertPaths(wi.worktree!, s.baseRef!, lockInfo.files);
      failure = (failure ? failure + "\n" : "") + "Gesperrter Abnahmetest wurde veraendert und zurueckgesetzt.";
    }

    if (!failure) {
      const stages = await runStages(ctx.store, wi.id, gp, wi.worktree!, 2);
      const acc = await runAcceptance(ctx.store, wi.id, gp, wi.worktree!, lockInfo.files);
      const all = summarize([...stages.results, acc]);
      gateEvents(ctx, wi, all.results);
      if (all.passed) {
        ctx.emit(wi, "acceptance.green", { gate_result_id: acc.id, model: route.model, attempt: failures + 1 });
        return ctx.save(wi, { lastFailure: undefined, lastImplModel: route.model });
      }
      failure = all.failureOutput;
    }
    s = st(ctx, ctx.save(wi, { implFailures: failures + 1, lastFailure: failure!, lastImplModel: route.model }));
    wi = ctx.store.getWorkItem(wi.id)!;
  }
  throw new Escalate(`Implementierung nach ${ctx.limits.implementAttempts} Versuchen nicht gruen`);
});

registerPhase("review", async (wi, ctx) => {
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= ctx.limits.reviewAttempts; attempt++) {
    // Reviewer sieht nur den Diff gegen den gesperrten Stand.
    const s = st(ctx, wi);
    await git(wi.worktree!, "add", "-A");
    const diff = await git(wi.worktree!, "diff", "--cached", s.baseRef!);
    const route = resolveModel(ctx.routing, "code-reviewer", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
    const res = await ctx.runRole(wi, "code-reviewer", route.model, reviewerPrompt(wi, diff, feedback));
    if (!res.ok) {
      feedback = res.feedback;
      continue;
    }
    const blocking = res.output.findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (res.output.verdict === "approve" && blocking.length === 0) {
      ctx.emit(wi, "review.approved", { model: route.model, findings: res.output.findings.length });
      return wi;
    }
    ctx.emit(wi, "review.changes_requested", { findings: res.output.findings });
    // Zurueck zur Implementierung mit den Befunden als Rueckmeldung.
    return ctx.save(wi, {
      phase: "implement",
      lastFailure: "Review-Befunde:\n" + res.output.findings.map((f) => `- [${f.severity}] ${f.text}`).join("\n"),
    });
  }
  throw new Escalate("Review lieferte keine gueltige Ausgabe");
});

registerPhase("integrate", async (wi, ctx) => {
  await git(wi.worktree!, "add", "-A");
  const prefix = wi.type === "bugfix" ? "fix" : wi.type === "feature" ? "feat" : wi.type === "refactor" ? "refactor" : "chore";
  const sha = await ctx.commit(wi.worktree!, `${prefix}: ${wi.title}\n\nUsac-Trace: ${wi.id}`);
  ctx.emit(wi, "integrated", { branch: wi.branch, commit: sha });
  // Nur als letzte Phase beendet integrate den Auftrag (bugfix); sonst folgen push/pr (feature).
  if (ctx.workflow.phases.at(-1)?.name !== "integrate") return wi;
  wi = ctx.save(wi, { phase: "done" }, { status: "done" });
  ctx.emit(wi, "workitem.done", { branch: wi.branch, commit: sha });
  return wi;
});

function gateEvents(ctx: PhaseContext, wi: WorkItem, results: GateResult[]) {
  for (const r of results) ctx.emit(wi, `gate.${r.status}`, { gate_result_id: r.id, name: r.name, exitCode: r.exitCode, durationMs: r.durationMs });
}

// ---- Orchestrator -----------------------------------------------------------------------

export function createOrchestrator(opts: OrchestratorOptions) {
  const { store, runner, pluginRoot, home } = opts;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const routing: RoutingConfig = loadRouting(pluginRoot);
  const auto = new Set(opts.approvals?.auto ?? []);
  const budgetUsed =
    opts.budgetUsed ??
    (() =>
      budgetUsedFraction(
        store,
        new Date(Date.now() - (opts.quota?.windowMs ?? DEFAULT_QUOTA_WINDOW_MS)),
        opts.quota?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ).fraction);

  function emit(wi: WorkItem, type: string, data: unknown = {}, spanId = wi.id, actor: Actor = "orchestrator") {
    return store.append({ traceId: wi.id, spanId, parentSpanId: spanId === wi.id ? null : wi.id, project: basename(wi.projectPath), type, actor, data });
  }

  function state(wi: WorkItem): State {
    return { phase: "setup", ...(wi.state as Partial<State>) } as State;
  }

  function save(wi: WorkItem, patch: Partial<State>, extra: Partial<Pick<WorkItem, "status" | "branch" | "worktree">> = {}): WorkItem {
    store.updateWorkItem(wi.id, { ...extra, state: { ...state(wi), ...patch } });
    return store.getWorkItem(wi.id)!;
  }

  /** Workflow-Datei zum Auftragstyp; Typen ohne eigene Datei laufen wie bisher als bugfix. */
  function workflowFor(type: WorkItemType): Workflow {
    const own = join(pluginRoot, "workflows", `${type}.yaml`);
    return loadWorkflow(existsSync(own) ? own : join(pluginRoot, "workflows", "bugfix.yaml"));
  }

  /** Startet eine Rolle, validiert Schema und Belege. Ungueltige Ausgaben gelten als Fehlversuch. */
  async function runRole<R extends RoleWithOutput>(
    wi: WorkItem,
    role: R,
    model: Model,
    prompt: string,
  ): Promise<{ ok: true; output: z.infer<(typeof ROLE_OUTPUTS)[R]> } | { ok: false; feedback: string }> {
    const spanId = `run_${randomBytes(5).toString("hex")}`;
    emit(wi, "run.started", { role, model }, spanId, `role:${role}`);
    const withGraph = existsSync(join(wi.worktree!, "graphify-out/graph.json")) ? `${prompt}\n\n${GRAPH_NOTE}` : prompt;
    const budget = new ContextBudget();
    const outcome = await runner.run(
      {
        role,
        model,
        prompt: withGraph,
        cwd: wi.worktree!,
        systemPrompt: rolePrompt(pluginRoot, role),
        schema: roleSchema(pluginRoot, role),
        maxTurns: limits.maxTurns,
        timeoutMs: limits.runTimeoutMs,
      },
      (e) => {
        if (e.kind === "usage" && e.context !== undefined) {
          // Melden, nie abbrechen: Auto-Compact kuemmert sich um den Kontext.
          if (budget.observe({ input_tokens: e.context })) {
            emit(wi, "budget.exceeded", { role, model, context: e.context, limit: budget.limit }, spanId, `role:${role}`);
          }
          return;
        }
        emit(wi, "run.output", e, spanId, `role:${role}`);
      },
    );
    emit(
      wi,
      "run.finished",
      { role, model, ok: outcome.ok, error: outcome.error, turns: outcome.turns, tokens: outcome.tokens, peak_context: budget.peak, context_limit: budget.limit },
      spanId,
      `role:${role}`,
    );
    if (!outcome.ok) return { ok: false, feedback: `Die Session ist fehlgeschlagen: ${outcome.error}` };

    const parsed = ROLE_OUTPUTS[role].safeParse(outcome.output);
    if (!parsed.success) {
      emit(wi, "output.invalid", { role, issues: parsed.error.issues.slice(0, 10) }, spanId);
      return { ok: false, feedback: `Deine Ausgabe entsprach nicht dem Schema: ${parsed.error.message.slice(0, 1500)}` };
    }
    const ctx = { cwd: wi.worktree!, store, workItemId: wi.id, urlAllowlist: opts.urlAllowlist };
    const errors: EvidenceError[] = validateClaims(parsed.data.claims, ctx);
    if ("findings" in parsed.data) errors.push(...validateFindings(parsed.data.findings, ctx));
    if (errors.length) {
      emit(wi, "evidence.invalid", { role, errors }, spanId);
      return { ok: false, feedback: `Belege ungueltig:\n${errors.map((e) => `- "${e.claim}": ${e.problem}`).join("\n")}` };
    }
    return { ok: true, output: parsed.data as z.infer<(typeof ROLE_OUTPUTS)[R]> };
  }

  async function commit(cwd: string, message: string) {
    let identity: string[] = [];
    try {
      await git(cwd, "config", "user.email");
    } catch {
      identity = ["-c", "user.name=US-AGENTIC-CODE", "-c", "user.email=usac@localhost"];
    }
    await git(cwd, ...identity, "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  }

  function context(spec: PhaseSpec, workflow: Workflow, profile: ProjectProfile, gateProfile: GateProfile): PhaseContext {
    return {
      spec,
      workflow,
      store,
      runner,
      pluginRoot,
      home,
      profile,
      gateProfile,
      limits,
      routing,
      autoApprovals: auto,
      available: opts.available,
      graphify: opts.graphify,
      urlAllowlist: opts.urlAllowlist,
      budgetUsed,
      emit,
      state,
      save,
      runRole,
      commit,
    };
  }

  // ---- Oeffentliche API ----------------------------------------------------------------

  return {
    async submit(input: SubmitInput): Promise<WorkItem> {
      const profile = loadProjectProfile(input.projectPath);
      const id = `wi_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      const wi = store.createWorkItem({
        id,
        projectPath: input.projectPath,
        type: input.type,
        title: input.title,
        description: input.description,
        size: input.size ?? "small",
      });
      emit(wi, "workitem.created", { type: input.type, title: input.title, project: profile.name });
      emit(wi, "workitem.classified", { size: wi.size, by: input.size ? "user" : "default" });
      return wi;
    },

    async run(id: string): Promise<RunResult> {
      let wi = store.getWorkItem(id);
      if (!wi) throw new Error(`WorkItem ${id} nicht gefunden`);
      if (wi.status === "done" || wi.status === "escalated") return { status: wi.status, branch: wi.branch };
      store.updateWorkItem(id, { status: "running" });
      wi = store.getWorkItem(id)!;
      const profile = loadProjectProfile(wi.projectPath);
      const gp = loadGateProfile(pluginRoot, profile.gate_profile);
      try {
        const workflow = workflowFor(wi.type);
        // Unbekannte Phasen brechen vor dem Start ab, statt still uebersprungen zu werden.
        const missing = missingPhases(workflow);
        if (missing.length) {
          throw new Error(
            `Workflow "${workflow.name}": kein Handler fuer Phase ${missing.map((n) => `"${n}"`).join(", ")} (registerPhase fehlt)`,
          );
        }
        // Startphase kommt aus dem Workflow, nicht aus dem Standardwert von state().
        if (!(wi.state as Partial<State> | null)?.phase) wi = save(wi, { phase: workflow.phases[0]!.name });
        for (let steps = 0; ; steps++) {
          const current: string = state(wi).phase;
          if (current === "done") break;
          if (steps >= MAX_PHASE_STEPS) {
            throw new Error(`Schutzgrenze erreicht: ${MAX_PHASE_STEPS} Phasenschritte in einem Lauf (Endlosschleife bei Phase "${current}"?)`);
          }
          const idx = workflow.phases.findIndex((p) => p.name === current);
          if (idx < 0) throw new Error(`Phase "${current}" steht nicht im Workflow "${workflow.name}"`);
          wi = await getPhase(current)!(wi, context(workflow.phases[idx]!, workflow, profile, gp));
          if (wi.status === "awaiting_approval") return { status: "awaiting_approval", branch: wi.branch };
          if (wi.status === "done") break;
          if (state(wi).phase !== current) continue; // Sprung, z. B. review -> implement
          const next = workflow.phases[idx + 1];
          if (next) {
            wi = save(wi, { phase: next.name });
          } else {
            wi = save(wi, { phase: "done" }, { status: "done" });
            emit(wi, "workitem.done", { branch: wi.branch });
          }
        }
        return { status: wi.status, branch: wi.branch };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const status = err instanceof Escalate ? "escalated" : "failed";
        store.updateWorkItem(id, { status });
        wi = store.getWorkItem(id)!;
        emit(wi, status === "escalated" ? "workitem.escalated" : "workitem.failed", { reason, phase: state(wi).phase });
        return { status, branch: wi.branch, reason };
      }
    },

    approve(approvalId: number, granted: boolean, note?: string) {
      const a = store.getApproval(approvalId);
      if (!a) throw new Error(`Freigabe ${approvalId} nicht gefunden`);
      store.resolveApproval(approvalId, granted, note);
      return a.workItemId;
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
