import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { ROLE_OUTPUTS, type Model, type RoleWithOutput, type Size, type WorkItemType } from "@usac/shared";
import { loadGateProfile, loadProjectProfile, matchesAny, type GateProfile } from "./config";
import { ContextBudget } from "./budget";
import { git } from "./exec";
import { excludeFromGit, hasGraphify, updateGraph } from "./graph";
import { validateClaims, validateFindings, type EvidenceError } from "./evidence";
import { runAcceptance, runStages, summarize } from "./gates";
import { changedFiles, checkImplementerDiff, hashFiles, revertPaths } from "./integrity";
import { GRAPH_NOTE, implementerPrompt, reviewerPrompt, rolePrompt, roleSchema, testEngineerPrompt } from "./prompts";
import { loadRouting, resolveModel, type RoutingConfig } from "./routing";
import type { Runner } from "./runner/types";
import type { GateResult, Store, WorkItem } from "./store";

export interface OrchestratorOptions {
  store: Store;
  runner: Runner;
  /** Wurzel des Plugins (agents/, schemas/, routing.yaml, gate-profiles/). */
  pluginRoot: string;
  /** ~/.usac oder ein Testordner; dort liegen Worktrees. */
  home: string;
  approvals?: { auto?: string[] };
  /** Anteil des verbrauchten Kontingents (0..1). */
  budgetUsed?: () => number;
  /** Im Abo verfuegbare Modelle. */
  available?: Model[];
  limits?: Partial<Limits>;
  urlAllowlist?: string[];
  /** Graphify-Graph im Worktree aufbauen (Standard: ja, wenn installiert). */
  graphify?: boolean;
}

interface Limits {
  acceptanceAttempts: number;
  implementAttempts: number;
  reviewAttempts: number;
  maxTurns: number;
  runTimeoutMs: number;
}

const DEFAULT_LIMITS: Limits = {
  acceptanceAttempts: 2,
  implementAttempts: 6,
  reviewAttempts: 3,
  maxTurns: 60,
  runTimeoutMs: 20 * 60_000,
};

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

type Phase = "setup" | "acceptance" | "approve_h1" | "lock" | "implement" | "review" | "integrate" | "done";

interface State {
  phase: Phase;
  acceptanceFiles?: string[];
  baseRef?: string;
  h1ApprovalId?: number;
  implFailures?: number;
  lastFailure?: string;
  lastImplModel?: Model;
  reviewFeedback?: string;
}

class Escalate extends Error {}

export function createOrchestrator(opts: OrchestratorOptions) {
  const { store, runner, pluginRoot, home } = opts;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const routing: RoutingConfig = loadRouting(pluginRoot);
  const auto = new Set(opts.approvals?.auto ?? []);

  function emit(wi: WorkItem, type: string, data: unknown = {}, spanId = wi.id, actor: `role:${string}` | "orchestrator" = "orchestrator") {
    return store.append({ traceId: wi.id, spanId, parentSpanId: spanId === wi.id ? null : wi.id, project: basename(wi.projectPath), type, actor, data });
  }

  function gateEvents(wi: WorkItem, results: GateResult[]) {
    for (const r of results) emit(wi, `gate.${r.status}`, { gate_result_id: r.id, name: r.name, exitCode: r.exitCode, durationMs: r.durationMs });
  }

  function state(wi: WorkItem): State {
    return { phase: "setup", ...(wi.state as Partial<State>) } as State;
  }

  function save(wi: WorkItem, patch: Partial<State>, extra: Partial<Pick<WorkItem, "status" | "branch" | "worktree">> = {}): WorkItem {
    store.updateWorkItem(wi.id, { ...extra, state: { ...state(wi), ...patch } });
    return store.getWorkItem(wi.id)!;
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

  // ---- Phasen ----------------------------------------------------------------------

  async function setup(wi: WorkItem, profile: { base_branch: string; name: string }): Promise<WorkItem> {
    const branch = `usac/${wi.id}`;
    const dir = join(home, "worktrees", profile.name, wi.id);
    mkdirSync(join(home, "worktrees", profile.name), { recursive: true });
    if (!existsSync(dir)) await git(wi.projectPath, "worktree", "add", "-q", "-b", branch, dir, profile.base_branch);
    // Erzeugte Artefakte gehoeren nie in einen Commit.
    await excludeFromGit(dir, ["graphify-out/", "luacov.stats.out", "luacov.report.out"]);
    wi = save(wi, { phase: "acceptance" }, { branch, worktree: dir });
    emit(wi, "worktree.created", { branch, path: dir, base: profile.base_branch });
    if (opts.graphify !== false && (await hasGraphify())) {
      const g = await updateGraph(dir);
      emit(wi, g.ok ? "graph.updated" : "graph.failed", { nodes: g.nodes, edges: g.edges, output: g.ok ? undefined : g.output });
    } else {
      emit(wi, "graph.skipped", { reason: opts.graphify === false ? "abgeschaltet" : "graphify nicht installiert" });
    }
    return wi;
  }

  async function acceptance(wi: WorkItem, gp: GateProfile): Promise<WorkItem> {
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= limits.acceptanceAttempts; attempt++) {
      const base = await git(wi.worktree!, "rev-parse", "HEAD");
      const route = resolveModel(routing, "test-engineer", { variant: "acceptance", size: wi.size, budgetUsed: opts.budgetUsed?.(), available: opts.available });
      const res = await runRole(wi, "test-engineer", route.model, testEngineerPrompt(wi, feedback));
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
        emit(wi, "anticheat.violation", { role: "test-engineer", nonTest, missing });
        feedback = `Nur Testdateien sind erlaubt. Verworfen: ${nonTest.join(", ") || "-"}. Fehlende oder ungueltige Testpfade: ${missing.join(", ") || "-"}`;
        continue;
      }
      const gate = await runAcceptance(store, wi.id, gp, wi.worktree!, files);
      gateEvents(wi, [gate]);
      if (gate.status === "passed") {
        emit(wi, "acceptance.rejected", { reason: "Abnahmetest ist ohne Aenderung schon gruen und beweist nichts", files });
        await revertPaths(wi.worktree!, base, await changedFiles(wi.worktree!, base));
        feedback = "Dein Abnahmetest war sofort gruen. Er muss das fehlende Verhalten beweisen und daher mit dem aktuellen Code rot sein.";
        continue;
      }
      emit(wi, "acceptance.red", { gate_result_id: gate.id, files });
      return save(wi, { phase: "approve_h1", acceptanceFiles: files });
    }
    throw new Escalate("Kein brauchbarer Abnahmetest nach " + limits.acceptanceAttempts + " Versuchen");
  }

  function approveH1(wi: WorkItem): WorkItem | null {
    const st = state(wi);
    let approval = st.h1ApprovalId ? store.getApproval(st.h1ApprovalId) : null;
    if (!approval) {
      approval = store.createApproval(wi.id, "h1", { files: st.acceptanceFiles, title: wi.title });
      emit(wi, "approval.requested", { approval_id: approval.id, kind: "h1", files: st.acceptanceFiles });
      wi = save(wi, { h1ApprovalId: approval.id });
      if (auto.has("h1")) {
        store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
        approval = store.getApproval(approval.id)!;
      }
    }
    if (approval.status === "pending") {
      save(wi, {}, { status: "awaiting_approval" });
      return null;
    }
    if (approval.status === "denied") throw new Escalate(`Abnahmetest abgelehnt: ${approval.note ?? ""}`);
    emit(wi, "approval.granted", { approval_id: approval.id, kind: "h1" });
    return save(wi, { phase: "lock" }, { status: "running" });
  }

  async function lock(wi: WorkItem): Promise<WorkItem> {
    const files = state(wi).acceptanceFiles!;
    const hash = hashFiles(wi.worktree!, files);
    store.saveLock(wi.id, files, hash);
    await git(wi.worktree!, "add", "--", ...files);
    const sha = await commit(wi.worktree!, `test: Abnahmetest fuer "${wi.title}"\n\nUsac-Trace: ${wi.id}`);
    emit(wi, "test.locked", { files, hash, commit: sha });
    return save(wi, { phase: "implement", baseRef: sha, implFailures: 0 });
  }

  async function implement(wi: WorkItem, gp: GateProfile): Promise<WorkItem> {
    let st = state(wi);
    const lockInfo = store.getLock(wi.id)!;
    while ((st.implFailures ?? 0) < limits.implementAttempts) {
      const failures = st.implFailures ?? 0;
      const route = resolveModel(routing, "implementer", { size: wi.size, failures, budgetUsed: opts.budgetUsed?.(), available: opts.available });
      if (st.lastImplModel && st.lastImplModel !== route.model) {
        emit(wi, "model.escalated", { role: "implementer", from: st.lastImplModel, to: route.model, reasons: route.reasons });
      }
      const res = await runRole(wi, "implementer", route.model, implementerPrompt(wi, lockInfo.files, st.lastFailure));
      let failure: string | null = null;
      if (!res.ok) failure = res.feedback;

      const violations = await checkImplementerDiff(wi.worktree!, st.baseRef!, gp, lockInfo.files);
      if (violations.length) {
        emit(wi, "anticheat.violation", { role: "implementer", violations });
        await revertPaths(wi.worktree!, st.baseRef!, violations.map((v) => v.path));
        failure = `Verstoesse wurden verworfen: ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}`;
      }
      if (hashFiles(wi.worktree!, lockInfo.files) !== lockInfo.hash) {
        await revertPaths(wi.worktree!, st.baseRef!, lockInfo.files);
        failure = (failure ? failure + "\n" : "") + "Gesperrter Abnahmetest wurde veraendert und zurueckgesetzt.";
      }

      if (!failure) {
        const stages = await runStages(store, wi.id, gp, wi.worktree!, 2);
        const acc = await runAcceptance(store, wi.id, gp, wi.worktree!, lockInfo.files);
        const all = summarize([...stages.results, acc]);
        gateEvents(wi, all.results);
        if (all.passed) {
          emit(wi, "acceptance.green", { gate_result_id: acc.id, model: route.model, attempt: failures + 1 });
          return save(wi, { phase: "review", lastFailure: undefined, lastImplModel: route.model });
        }
        failure = all.failureOutput;
      }
      st = state(save(wi, { implFailures: failures + 1, lastFailure: failure!, lastImplModel: route.model }));
      wi = store.getWorkItem(wi.id)!;
    }
    throw new Escalate(`Implementierung nach ${limits.implementAttempts} Versuchen nicht gruen`);
  }

  async function review(wi: WorkItem): Promise<WorkItem> {
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= limits.reviewAttempts; attempt++) {
      // Reviewer sieht nur den Diff gegen den gesperrten Stand.
      const st = state(wi);
      await git(wi.worktree!, "add", "-A");
      const diff = await git(wi.worktree!, "diff", "--cached", st.baseRef!);
      const route = resolveModel(routing, "code-reviewer", { size: wi.size, budgetUsed: opts.budgetUsed?.(), available: opts.available });
      const res = await runRole(wi, "code-reviewer", route.model, reviewerPrompt(wi, diff, feedback));
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const blocking = res.output.findings.filter((f) => f.severity === "critical" || f.severity === "high");
      if (res.output.verdict === "approve" && blocking.length === 0) {
        emit(wi, "review.approved", { model: route.model, findings: res.output.findings.length });
        return save(wi, { phase: "integrate" });
      }
      emit(wi, "review.changes_requested", { findings: res.output.findings });
      // Zurueck zur Implementierung mit den Befunden als Rueckmeldung.
      return save(wi, {
        phase: "implement",
        lastFailure: "Review-Befunde:\n" + res.output.findings.map((f) => `- [${f.severity}] ${f.text}`).join("\n"),
      });
    }
    throw new Escalate("Review lieferte keine gueltige Ausgabe");
  }

  async function integrate(wi: WorkItem): Promise<WorkItem> {
    await git(wi.worktree!, "add", "-A");
    const prefix = wi.type === "bugfix" ? "fix" : wi.type === "feature" ? "feat" : wi.type === "refactor" ? "refactor" : "chore";
    const sha = await commit(wi.worktree!, `${prefix}: ${wi.title}\n\nUsac-Trace: ${wi.id}`);
    emit(wi, "integrated", { branch: wi.branch, commit: sha });
    wi = save(wi, { phase: "done" }, { status: "done" });
    emit(wi, "workitem.done", { branch: wi.branch, commit: sha });
    return wi;
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
        for (;;) {
          const phase = state(wi).phase;
          if (phase === "setup") wi = await setup(wi, profile);
          else if (phase === "acceptance") wi = await acceptance(wi, gp);
          else if (phase === "approve_h1") {
            const next = approveH1(wi);
            if (!next) return { status: "awaiting_approval", branch: wi.branch };
            wi = next;
          } else if (phase === "lock") wi = await lock(wi);
          else if (phase === "implement") wi = await implement(wi, gp);
          else if (phase === "review") wi = await review(wi);
          else if (phase === "integrate") wi = await integrate(wi);
          else break;
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
