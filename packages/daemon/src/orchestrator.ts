import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  ROLE_OUTPUTS,
  type AcceptanceCriterion,
  type AnalystOutput,
  type Model,
  type RoleWithOutput,
  type Size,
  type Slice,
  type WorkItemType,
} from "@usac/shared";
import { loadGateProfile, loadProjectProfile, matchesAny, type GateProfile, type ProjectProfile } from "./config";
import { ContextBudget } from "./budget";
import { git } from "./exec";
import { excludeFromGit, hasGraphify, updateGraph } from "./graph";
import { validateClaims, validateFindings, type EvidenceError } from "./evidence";
import { runAcceptance, runStages, summarize } from "./gates";
import { changedFiles, checkImplementerDiff, hashFiles, revertPaths } from "./integrity";
import { Escalate, getPhase, missingPhases, registerPhase, type Actor, type PhaseContext, type PhaseLimits, type RunRoleOptions } from "./phases";
import { cleanupStalePreviews } from "./preview";
import { readHookLog } from "./hook-log";
import { HEARTBEAT_MS, PROJECT_WIDE, acquireLeases, ensureLeaseSchema, heartbeat, leasesOf, normalizeLeasePath, releaseLeases } from "./leases";
import { GRAPH_NOTE, implementerPrompt, rolePrompt, roleSchema, testEngineerPrompt } from "./prompts";
import { budgetUsedFraction, DEFAULT_MAX_TOKENS } from "./quota";
import { createReviewHandler } from "./review";
import { loadRouting, loadRoutingOverride, resolveModel, type RoutingConfig } from "./routing";
import { applyDowngrade, evaluateTrials, suggestDowngrades, type DowngradeSuggestion } from "./downgrade";
import { computeMetrics } from "./metrics";
import { validateHosts } from "./runner/claude";
import type { Runner } from "./runner/types";
import { MAX_PARALLEL, ensureSlotSchema, releaseSlot, slotHeartbeat, tryAcquireSlot } from "./scheduler";
import type { Approval, GateResult, Store, WorkItem } from "./store";
import { createTeamHandlers } from "./team-phases";
import { createTestDb, dropTestDb } from "./testdb";
import { activePhases, loadWorkflow, type PhaseSpec, type Workflow } from "./workflow";

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

/** Rollen, fuer die GateGuard aktiv ist (nie Bash, siehe hooks/scripts/gateguard.ts). */
const GATEGUARD_ROLES = new Set<string>(["implementer", "build-fixer"]);

/** Endzustaende, in denen ein Auftrag seine Leases abgibt. */
const FINAL_STATUSES = new Set<WorkItem["status"]>(["done", "failed", "escalated"]);

export interface RunOptions {
  /** Der Scheduler hat den Slot schon vergeben (tryAcquireSlot); run() holt dann keinen eigenen. */
  slotHeld?: boolean;
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
  /** Feature-Workflow (feature-phases.ts): Spec und Slice-Plan. */
  spec?: AnalystOutput;
  slices?: Slice[];
  sliceOrder?: string[];
  /** Rote Tests je Slice-ID; erledigte Slices werden beim Wiedereintritt uebersprungen. */
  sliceTests?: Record<string, string[]>;
  /** Umgebung der Test-Datenbank (DATABASE_URL), angelegt in setup bei `profile.test_db`. */
  testDbEnv?: Record<string, string>;
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
  // baseRef: Abzweig vom Basis-Branch; lock ersetzt ihn durch den Test-Commit. Workflows ohne lock
  // (dependency-update, spike) vergleichen damit im Review gegen den Stand vor dem Auftrag.
  const s = st(ctx, wi);
  wi = ctx.save(wi, s.baseRef ? {} : { baseRef: await git(dir, "rev-parse", "HEAD") }, { branch, worktree: dir });
  ctx.emit(wi, "worktree.created", { branch, path: dir, base: profile.base_branch });
  if (profile.test_db && !s.testDbEnv) {
    const db = await createTestDb({ wiId: wi.id, cwd: dir, cfg: profile.test_db });
    wi = ctx.save(wi, { testDbEnv: db.env });
    ctx.emit(wi, "testdb.created", { kind: profile.test_db.kind });
  }
  if (ctx.graphify !== false && (await hasGraphify())) {
    const g = await updateGraph(dir);
    ctx.emit(wi, g.ok ? "graph.updated" : "graph.failed", { nodes: g.nodes, edges: g.edges, output: g.ok ? undefined : g.output });
  } else {
    ctx.emit(wi, "graph.skipped", { reason: ctx.graphify === false ? "abgeschaltet" : "graphify nicht installiert" });
  }
  return wi;
});

/** Rot-Pruefung fuer einen Slice (oder ohne Slice den ganzen Auftrag, bugfix). */
type SliceInput = { slice: Slice; criteria: AcceptanceCriterion[] };

/**
 * Versuchsschleife des Test Engineers. `earlier` sind die Tests frueherer Slices: sie sind
 * noch nicht committet, daher sichert der Handler ihren Inhalt vor jedem Versuch und stellt
 * ihn wieder her, wenn der Test Engineer sie anfasst (das zaehlt als Fehlversuch).
 */
async function writeRedTest(wi: WorkItem, ctx: PhaseContext, input?: SliceInput, earlier: string[] = []): Promise<{ files: string[]; gateId: number }> {
  const gp = ctx.gateProfile;
  const sliceData = input ? { slice: input.slice.id } : {};
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= ctx.limits.acceptanceAttempts; attempt++) {
    const base = await git(wi.worktree!, "rev-parse", "HEAD");
    const saved = new Map(earlier.map((f) => [f, readFileSync(join(wi.worktree!, f))] as const));
    const route = resolveModel(ctx.routing, "test-engineer", {
      variant: ctx.spec.variant ?? "acceptance",
      size: wi.size,
      budgetUsed: ctx.budgetUsed(),
      available: ctx.available,
    });
    const res = await ctx.runRole(wi, "test-engineer", route.model, testEngineerPrompt(wi, feedback, input));
    // Eigene Aenderungen dieses Versuchs; Tests frueherer Slices bleiben davon ausgenommen.
    const own = async () => (await changedFiles(wi.worktree!, base)).filter((p) => !saved.has(p));
    const touched = earlier.filter((f) => !existsSync(join(wi.worktree!, f)) || !readFileSync(join(wi.worktree!, f)).equals(saved.get(f)!));
    if (touched.length) {
      for (const f of touched) writeFileSync(join(wi.worktree!, f), saved.get(f)!);
      await revertPaths(wi.worktree!, base, await own());
      ctx.emit(wi, "anticheat.violation", { role: "test-engineer", ...sliceData, touched });
      feedback = `Tests frueherer Slices sind tabu und wurden zurueckgesetzt: ${touched.join(", ")}`;
      continue;
    }
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
      ctx.emit(wi, "anticheat.violation", { role: "test-engineer", ...sliceData, nonTest, missing });
      feedback = `Nur Testdateien sind erlaubt. Verworfen: ${nonTest.join(", ") || "-"}. Fehlende oder ungueltige Testpfade: ${missing.join(", ") || "-"}`;
      continue;
    }
    const gate = await runAcceptance(ctx.store, wi.id, gp, wi.worktree!, files);
    gateEvents(ctx, wi, [gate]);
    if (gate.status === "passed") {
      ctx.emit(wi, "acceptance.rejected", { reason: "Abnahmetest ist ohne Aenderung schon gruen und beweist nichts", ...sliceData, files });
      await revertPaths(wi.worktree!, base, await own());
      feedback = "Dein Abnahmetest war sofort gruen. Er muss das fehlende Verhalten beweisen und daher mit dem aktuellen Code rot sein.";
      continue;
    }
    ctx.emit(wi, "acceptance.red", { ...sliceData, gate_result_id: gate.id, files });
    return { files, gateId: gate.id };
  }
  throw new Escalate(
    "Kein brauchbarer Abnahmetest" + (input ? ` fuer Slice ${input.slice.id}` : "") + " nach " + ctx.limits.acceptanceAttempts + " Versuchen",
  );
}

/** Sammel-Slice fuer eine Spec ohne Plan; dieselbe Form nutzt verify (criteriaContext in team-phases.ts). */
function wholeSpecSlice(criteria: AcceptanceCriterion[]): Slice {
  return { id: "S0", title: "Gesamt", criteria: criteria.map((c) => c.id), files: [], depends_on: [] };
}

/** Vereinigung der Slice-Tests in sliceOrder-Reihenfolge, ohne Duplikate. */
function unionSliceTests(order: string[], tests: Record<string, string[]>): string[] {
  return [...new Set(order.flatMap((id) => tests[id] ?? []))];
}

registerPhase("acceptance", async (wi, ctx) => {
  const s = st(ctx, wi);
  if (!s.slices) {
    // Spec ohne Plan (change): Sammel-Slice S0 mit allen Kriterien, damit der Test Engineer die
    // Marken [AC-n] setzt, die verify (Stufe 6) ueber denselben Sammel-Slice prueft.
    const input = s.spec ? { slice: wholeSpecSlice(s.spec.criteria), criteria: s.spec.criteria } : undefined;
    const { files } = await writeRedTest(wi, ctx, input);
    return ctx.save(wi, { acceptanceFiles: files });
  }
  const order = s.sliceOrder ?? s.slices.map((x) => x.id);
  const sliceTests: Record<string, string[]> = { ...s.sliceTests };
  // Resume: Tests erledigter Slices sind bis lock unversioniert. Fehlt einer, ist der rote
  // Nachweis verloren; das entscheidet ein Mensch, der Lauf darf nicht still weitergehen.
  const lost = unionSliceTests(order, sliceTests).filter((f) => !existsSync(join(wi.worktree!, f)));
  if (lost.length) throw new Escalate(`Tests erledigter Slices fehlen im Worktree: ${lost.join(", ")}`);
  for (const id of order) {
    if (sliceTests[id]) continue; // Resume: Slice hat schon einen roten Test
    const slice = s.slices.find((x) => x.id === id);
    if (!slice) throw new Error(`Slice ${id} aus sliceOrder fehlt im Plan`);
    const criteria = (s.spec?.criteria ?? []).filter((c) => slice.criteria.includes(c.id));
    const earlier = unionSliceTests(order, sliceTests);
    const { files } = await writeRedTest(wi, ctx, { slice, criteria }, earlier);
    sliceTests[id] = files;
    wi = ctx.save(wi, { sliceTests: { ...sliceTests } });
  }
  return ctx.save(wi, { sliceTests, acceptanceFiles: unionSliceTests(order, sliceTests) });
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
  const s = st(ctx, wi);
  const files = s.acceptanceFiles!;
  // feature: geplante Dateien plus Abnahmetests; bugfix hat keinen Plan und sperrt das Projekt.
  const wanted = s.slices ? [...new Set([...s.slices.flatMap((x) => x.files), ...files])] : [PROJECT_WIDE];
  const got = acquireLeases(ctx.store, wi.projectPath, wi.id, wanted, Date.now());
  if (!got.ok) {
    ctx.emit(wi, "lease.wait", { conflicts: got.conflicts });
    return ctx.save(wi, {}, { status: "queued" });
  }
  ctx.emit(wi, "lease.acquired", { paths: wanted.map(normalizeLeasePath) });
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
    const busy = await enforceLeases(wi, ctx, s.baseRef!);
    if (busy) failure = (failure ? failure + "\n" : "") + busy;

    if (!failure) {
      // Stufen 1–2 mit Lauf-Kontext (Basis-Commit, Test-DB); Stufen 3–6 laufen in verify (team-phases.ts).
      const stageCtx = { workItemType: wi.type, baseRef: s.baseRef!, env: s.testDbEnv ?? {} };
      const stages = await runStages(ctx.store, wi.id, gp, wi.worktree!, 2, stageCtx);
      // Mit Slices: je Slice ein eigener Abnahmelauf nur mit dessen Tests; alle muessen gruen sein.
      const groups: { slice?: string; files: string[] }[] = s.slices
        ? (s.sliceOrder ?? s.slices.map((x) => x.id)).map((id) => ({ slice: id, files: s.sliceTests?.[id] ?? [] }))
        : [{ files: lockInfo.files }];
      const accs: GateResult[] = [];
      for (const g of groups) accs.push(await runAcceptance(ctx.store, wi.id, gp, wi.worktree!, g.files));
      const all = summarize([...stages.results, ...accs]);
      gateEvents(ctx, wi, all.results);
      if (all.passed) {
        groups.forEach((g, i) =>
          ctx.emit(wi, "acceptance.green", {
            ...(g.slice ? { slice: g.slice } : {}),
            gate_result_id: accs[i]!.id,
            model: route.model,
            attempt: failures + 1,
          }),
        );
        return ctx.save(wi, { lastFailure: undefined, lastImplModel: route.model });
      }
      failure = all.failureOutput;
    }
    s = st(ctx, ctx.save(wi, { implFailures: failures + 1, lastFailure: failure!, lastImplModel: route.model }));
    wi = ctx.store.getWorkItem(wi.id)!;
  }
  throw new Escalate(`Implementierung nach ${ctx.limits.implementAttempts} Versuchen nicht gruen`);
});

// Review mit einem oder zwei Sitzen (review.ts, ADR 0004); ersetzt den frueheren eingebauten Handler.
registerPhase("review", createReviewHandler());

// Erweitertes Team (team-phases.ts): design, environment, qa, verify, security, characterize, research.
for (const [name, handler] of Object.entries(createTeamHandlers())) registerPhase(name, handler);

/** Conventional-Commit-Praefix je Auftragstyp. */
const COMMIT_PREFIX: Partial<Record<WorkItemType, string>> = {
  bugfix: "fix",
  "security-fix": "fix",
  feature: "feat",
  change: "feat",
  "new-project": "feat",
  refactor: "refactor",
  spike: "docs",
};

registerPhase("integrate", async (wi, ctx) => {
  await git(wi.worktree!, "add", "-A");
  // Nichts vorgemerkt (z. B. dependency-update: environment hat schon committet): kein leerer Commit.
  const staged = await git(wi.worktree!, "diff", "--cached", "--name-only");
  const sha = staged
    ? await ctx.commit(wi.worktree!, `${COMMIT_PREFIX[wi.type] ?? "chore"}: ${wi.title}\n\nUsac-Trace: ${wi.id}`)
    : await git(wi.worktree!, "rev-parse", "HEAD");
  ctx.emit(wi, "integrated", { branch: wi.branch, commit: sha, ...(staged ? {} : { empty: true }) });
  // Nur als letzte Phase beendet integrate den Auftrag (bugfix); sonst folgen push/pr (feature).
  if (ctx.workflow.phases.at(-1)?.name !== "integrate") return wi;
  wi = ctx.save(wi, { phase: "done" }, { status: "done" });
  ctx.emit(wi, "workitem.done", { branch: wi.branch, commit: sha });
  return wi;
});

/**
 * Geaenderte Dateien ausserhalb der eigenen Leases: freie Pfade werden nachtraeglich genommen
 * (`lease.extended`), von anderen gehaltene zurueckgesetzt. Liefert die Rueckmeldung oder null.
 */
async function enforceLeases(wi: WorkItem, ctx: PhaseContext, baseRef: string): Promise<string | null> {
  const own = new Set(leasesOf(ctx.store, wi.id));
  if (own.has(PROJECT_WIDE)) return null;
  const busy: string[] = [];
  const lines: string[] = [];
  for (const raw of await changedFiles(wi.worktree!, baseRef)) {
    const p = normalizeLeasePath(raw);
    if (own.has(p)) continue;
    const r = acquireLeases(ctx.store, wi.projectPath, wi.id, [p], Date.now());
    if (r.ok) {
      own.add(p);
      ctx.emit(wi, "lease.extended", { path: p });
    } else {
      busy.push(raw);
      lines.push(`Datei ${p} ist von ${r.conflicts[0]!.holder} belegt`);
    }
  }
  if (!busy.length) return null;
  await revertPaths(wi.worktree!, baseRef, busy);
  ctx.emit(wi, "lease.conflict", { paths: busy });
  return lines.join("\n");
}

/** Begruendung fuer `phase.skipped`: welche Bedingung aus `when` nicht zutrifft. */
function skipReason(p: PhaseSpec, wi: WorkItem, profile: ProjectProfile): string {
  const w = p.when ?? {};
  const reasons: string[] = [];
  if (w.size && !w.size.includes(wi.size)) reasons.push(`Größe ${wi.size} nicht in [${w.size.join(", ")}]`);
  if (w.preview === true && !profile.preview) reasons.push("keine Preview im Projektprofil");
  if (w.preview === false && profile.preview) reasons.push("Preview im Projektprofil konfiguriert");
  return reasons.join("; ") || "Bedingung trifft nicht zu";
}

function gateEvents(ctx: PhaseContext, wi: WorkItem, results: GateResult[]) {
  for (const r of results) ctx.emit(wi, `gate.${r.status}`, { gate_result_id: r.id, name: r.name, exitCode: r.exitCode, durationMs: r.durationMs });
}

// ---- Orchestrator -----------------------------------------------------------------------

/** Ort der Routing-Overrides je Installation (ADR 0010: routing.yaml im Plugin bleibt unveraendert). */
export const overridePathFor = (home: string): string => join(home, "routing.override.yaml");

/** Kennung der Ereignisse, die nicht zu einem Auftrag gehoeren (Herabstufung, Probebetrieb). */
const ROUTING_TRACE = "routing";

/** Metrik-Stichtag fuer Routing-Auswertungen: alle Ereignisse zaehlen. */
const ALL_TIME = { periodStart: new Date(0), periodDays: 3650 };

/**
 * Wendet eine erteilte Freigabe `routing_change` auf den Override an. Gibt false zurueck,
 * wenn die Freigabe nicht von dieser Art oder nicht erteilt ist.
 */
export function applyRoutingApproval(a: Approval, overridePath: string, now: Date): boolean {
  if (a.kind !== "routing_change" || a.status !== "granted") return false;
  const c = a.context as DowngradeSuggestion;
  applyDowngrade(overridePath, { role: c.role, variant: c.variant, from: c.from, to: c.to, evidence: c.evidence }, now);
  return true;
}

/**
 * Legt je Herabstufungs-Vorschlag eine Freigabe `routing_change` an. Vorschlaege, zu denen es schon
 * eine Freigabe (offen, erteilt oder abgelehnt) mit gleichem Schluessel und Ziel gibt, entfallen.
 * Die Freigabe ist die einzige Stelle, die Routing aendert; hier passiert nichts am Override.
 */
export function suggestRoutingApprovals(
  store: Store,
  opts: { pluginRoot: string; home: string; now: Date },
): { key: string; from: string; to: string; approvalId: number }[] {
  const routing = loadRouting(opts.pluginRoot, overridePathFor(opts.home));
  const stats = computeMetrics(store.events(), { ...ALL_TIME, now: opts.now }).roles;
  const known = new Set(
    (store.db.query("SELECT context FROM approvals WHERE kind = 'routing_change'").all() as { context: string }[]).map((r) => {
      const c = JSON.parse(r.context) as DowngradeSuggestion;
      return `${c.role}.${c.variant ?? ""}->${c.to}`;
    }),
  );
  const out: { key: string; from: string; to: string; approvalId: number }[] = [];
  for (const s of suggestDowngrades(stats, routing)) {
    const dedup = `${s.role}.${s.variant ?? ""}->${s.to}`;
    if (known.has(dedup)) continue;
    known.add(dedup);
    const key = s.variant ? `${s.role}.${s.variant}` : s.role;
    const a = store.createApproval(ROUTING_TRACE, "routing_change", s);
    store.append({
      traceId: ROUTING_TRACE,
      spanId: ROUTING_TRACE,
      parentSpanId: null,
      project: "usac",
      type: "approval.requested",
      actor: "orchestrator",
      data: { approval_id: a.id, kind: "routing_change", blocking: false, key },
    });
    out.push({ key, from: s.from, to: s.to, approvalId: a.id });
  }
  return out;
}

export function createOrchestrator(opts: OrchestratorOptions) {
  const { store, runner, pluginRoot, home } = opts;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const routing: RoutingConfig = loadRouting(pluginRoot, overridePathFor(home));
  const auto = new Set(opts.approvals?.auto ?? []);
  ensureLeaseSchema(store);
  ensureSlotSchema(store);
  // Previews eines abgebrochenen Vorlaufs beenden (PID-Dateien unter <home>/previews).
  cleanupStalePreviews(join(home, "previews"));
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

  /** Betroffene Dateien eines Rollen-Ergebnisses: geaenderte Dateien bzw. Abnahmetests. */
  function stepFiles(output: unknown): string[] {
    const o = output as { changed_files?: string[]; acceptance_tests?: string[] };
    return o.changed_files ?? o.acceptance_tests ?? [];
  }

  /** Startet eine Rolle und speichert den Aufruf als Story-Schritt (Rolle, Modell, Ergebnis, Dateien, Zeitraum). */
  async function runRole<R extends RoleWithOutput>(
    wi: WorkItem,
    role: R,
    model: Model,
    prompt: string,
    roleOpts: RunRoleOptions = {},
  ): Promise<{ ok: true; output: z.infer<(typeof ROLE_OUTPUTS)[R]> } | { ok: false; feedback: string }> {
    const startedAt = new Date().toISOString();
    const res = await runRoleInner(wi, role, model, prompt, roleOpts);
    const files = res.ok ? stepFiles(res.output) : [];
    store.recordStep({
      workItemId: wi.id,
      role,
      model,
      ok: res.ok,
      ...(res.ok ? {} : { reason: res.feedback.slice(0, 500) }),
      files,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return res;
  }

  /** Startet eine Rolle, validiert Schema und Belege. Ungueltige Ausgaben gelten als Fehlversuch. */
  async function runRoleInner<R extends RoleWithOutput>(
    wi: WorkItem,
    role: R,
    model: Model,
    prompt: string,
    roleOpts: RunRoleOptions = {},
  ): Promise<{ ok: true; output: z.infer<(typeof ROLE_OUTPUTS)[R]> } | { ok: false; feedback: string }> {
    const spanId = `run_${randomBytes(5).toString("hex")}`;
    const profile = loadProjectProfile(wi.projectPath);
    const gp = loadGateProfile(pluginRoot, profile.gate_profile);
    const hookLog = join(home, "hooklogs", `${spanId}.jsonl`);
    // Test-DB und Zusatzumgebung der Phase zuerst; die USAC_*-Variablen der Hooks ueberschreibt keine Phase.
    const env: Record<string, string> = {
      ...(state(store.getWorkItem(wi.id) ?? wi).testDbEnv ?? {}),
      ...roleOpts.env,
      USAC_HOOK_LOG: hookLog,
      USAC_PROTECTOR_MODE: profile.protector.mode,
      USAC_WORK_ITEM: wi.id,
    };
    if (GATEGUARD_ROLES.has(role) && profile.gateguard.enabled) env.USAC_GATEGUARD = "1";
    const networkAllow = validateHosts([...new Set([...gp.network_allow, ...profile.network.allow])]);
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
        env,
        networkAllow,
        ...(roleOpts.disallowedTools?.length ? { disallowedTools: roleOpts.disallowedTools } : {}),
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
    hookEvents(wi, role, spanId, hookLog);
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

  /** Hook-Log einer Session als Events; jede `reported`-Zeile wird eine nicht blockierende Freigabe `protector`. */
  function hookEvents(wi: WorkItem, role: string, spanId: string, path: string) {
    for (const { hook, action, ...rest } of readHookLog(path)) {
      emit(wi, `${hook}.${action}`, { role, ...rest }, spanId, `role:${role}`);
      if (action !== "reported") continue;
      const a = store.createApproval(wi.id, "protector", { role, hook, span: spanId, ...rest });
      emit(wi, "approval.requested", { approval_id: a.id, kind: "protector", blocking: false }, spanId, `role:${role}`);
    }
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

  /** Loescht die Test-DB eines beendeten Auftrags (done/failed/escalated); Fehler werden gemeldet, nicht geworfen. */
  async function dropDb(wi: WorkItem) {
    const env = state(wi).testDbEnv;
    if (!env || !wi.worktree) return;
    const cfg = loadProjectProfile(wi.projectPath).test_db;
    try {
      if (cfg) await dropTestDb({ wiId: wi.id, cwd: wi.worktree, cfg });
      wi = save(wi, { testDbEnv: undefined });
      emit(wi, "testdb.dropped", { kind: cfg?.kind ?? null });
    } catch (err) {
      emit(wi, "testdb.drop_failed", { reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Wertet laufende Herabstufungs-Proben aus (nach jedem Lauf). Gewertet werden nur Ereignisse seit dem
   * fruehesten Probebeginn; Probe-Modelle kommen vor Probebeginn nicht vor, daher zaehlt nichts Altes mit.
   */
  function checkTrials(): void {
    const path = overridePathFor(home);
    const ov = loadRoutingOverride(path);
    const starts = Object.values(ov.trials).map((t) => Date.parse(t.startedAt));
    if (!starts.length) return;
    const since = Math.min(...starts);
    const events = store.events().filter((e) => Date.parse(e.ts) >= since);
    const { reverted, confirmed } = evaluateTrials(path, computeMetrics(events, { ...ALL_TIME, now: new Date() }).roles);
    const ev = (type: string, key: string) =>
      store.append({ traceId: ROUTING_TRACE, spanId: ROUTING_TRACE, parentSpanId: null, project: "usac", type, actor: "orchestrator", data: { key } });
    for (const key of reverted) ev("routing.trial_reverted", key);
    for (const key of confirmed) ev("routing.trial_confirmed", key);
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

    async run(id: string, runOpts: RunOptions = {}): Promise<RunResult> {
      let wi = store.getWorkItem(id);
      if (!wi) throw new Error(`WorkItem ${id} nicht gefunden`);
      if (wi.status === "done" || wi.status === "escalated") return { status: wi.status, branch: wi.branch };
      if (runOpts.slotHeld) {
        store.updateWorkItem(id, { status: "running" });
      } else {
        // Ein belegter Slot heisst: ein anderer Lauf (z. B. der Daemon) fuehrt den Auftrag gerade aus.
        if (store.db.query("SELECT 1 FROM slots WHERE work_item_id = ?").get(id)) {
          return { status: wi.status, branch: wi.branch, reason: "Auftrag laeuft bereits (Slot belegt)" };
        }
        if (wi.status !== "queued") store.updateWorkItem(id, { status: "queued" });
        if (!tryAcquireSlot(store, id, MAX_PARALLEL, Date.now())) {
          wi = store.getWorkItem(id)!;
          emit(wi, "slot.wait", { max: MAX_PARALLEL });
          return { status: "queued", branch: wi.branch };
        }
      }
      wi = store.getWorkItem(id)!;
      const timer = setInterval(() => {
        const t = Date.now();
        slotHeartbeat(store, id, t);
        heartbeat(store, id, t);
      }, HEARTBEAT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        const profile = loadProjectProfile(wi.projectPath);
        const gp = loadGateProfile(pluginRoot, profile.gate_profile);
        const workflow = workflowFor(wi.type);
        // Unbekannte Phasen brechen vor dem Start ab, statt still uebersprungen zu werden.
        const missing = missingPhases(workflow);
        if (missing.length) {
          throw new Error(
            `Workflow "${workflow.name}": kein Handler fuer Phase ${missing.map((n) => `"${n}"`).join(", ")} (registerPhase fehlt)`,
          );
        }
        /**
         * Geht ab Index `from` zur ersten Phase, deren `when` fuer Auftrag und Projekt zutrifft
         * (activePhases, mit der aktuellen Groesse); uebersprungene Phasen werden gemeldet.
         * Ohne weitere Phase ist der Auftrag fertig.
         */
        const advance = (cur: WorkItem, from: number): WorkItem => {
          const active = new Set(activePhases(workflow, cur, profile).map((p) => p.name));
          for (let i = from; i < workflow.phases.length; i++) {
            const p = workflow.phases[i]!;
            if (active.has(p.name)) return save(cur, { phase: p.name });
            emit(cur, "phase.skipped", { name: p.name, reason: skipReason(p, cur, profile) });
          }
          cur = save(cur, { phase: "done" }, { status: "done" });
          emit(cur, "workitem.done", { branch: cur.branch });
          return cur;
        };
        // Startphase kommt aus dem Workflow, nicht aus dem Standardwert von state().
        if (!(wi.state as Partial<State> | null)?.phase) wi = advance(wi, 0);
        for (let steps = 0; ; steps++) {
          const current: string = state(wi).phase;
          if (current === "done" || wi.status === "done") break;
          if (steps >= MAX_PHASE_STEPS) {
            throw new Error(`Schutzgrenze erreicht: ${MAX_PHASE_STEPS} Phasenschritte in einem Lauf (Endlosschleife bei Phase "${current}"?)`);
          }
          const idx = workflow.phases.findIndex((p) => p.name === current);
          if (idx < 0) throw new Error(`Phase "${current}" steht nicht im Workflow "${workflow.name}"`);
          // Ziel eines Sprungs oder Resume, dessen Bedingung nicht (mehr) zutrifft: weiter zur naechsten.
          if (!activePhases(workflow, wi, profile).some((p) => p.name === current)) {
            wi = advance(wi, idx);
            continue;
          }
          // Ein Phasenwechsel ist ein Ereignis; nach einer Freigabe betritt der Lauf dieselbe Phase erneut, ohne neues Ereignis.
          const lastEntered = store.events({ traceId: wi.id, type: "phase.entered" }).at(-1);
          if ((lastEntered?.data as { name?: unknown } | undefined)?.name !== current) emit(wi, "phase.entered", { name: current });
          wi = await getPhase(current)!(wi, context(workflow.phases[idx]!, workflow, profile, gp));
          if (wi.status === "awaiting_approval") return { status: "awaiting_approval", branch: wi.branch };
          if (wi.status === "queued") return { status: "queued", branch: wi.branch }; // z. B. lease.wait
          if (wi.status === "done") break;
          const target = state(wi).phase;
          if (target !== current) {
            // Sprung, z. B. review -> implement. Ein Ziel, das der Workflow nicht hat (verify in
            // dependency-update ohne implement), kann niemand abarbeiten: dann entscheidet ein Mensch.
            if (!workflow.phases.some((p) => p.name === target)) {
              const lastFailure = state(wi).lastFailure;
              wi = save(wi, { phase: current });
              throw new Escalate(
                `Phase "${current}" verlangt Ruecksprung nach "${target}", den Workflow "${workflow.name}" nicht hat` +
                  (lastFailure ? `:\n${lastFailure}` : ""),
              );
            }
            continue;
          }
          wi = advance(wi, idx + 1);
        }
        return { status: wi.status, branch: wi.branch };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const status = err instanceof Escalate ? "escalated" : "failed";
        store.updateWorkItem(id, { status });
        wi = store.getWorkItem(id)!;
        emit(wi, status === "escalated" ? "workitem.escalated" : "workitem.failed", { reason, phase: state(wi).phase });
        return { status, branch: wi.branch, reason };
      } finally {
        clearInterval(timer);
        releaseSlot(store, id);
        // Leases bleiben bei awaiting_approval und queued erhalten (offene Entscheidung 2 im Plan).
        const cur = store.getWorkItem(id);
        if (cur && FINAL_STATUSES.has(cur.status)) {
          releaseLeases(store, id);
          await dropDb(cur);
        }
        checkTrials();
      }
    },

    approve(approvalId: number, granted: boolean, note?: string) {
      const a = store.getApproval(approvalId);
      if (!a) throw new Error(`Freigabe ${approvalId} nicht gefunden`);
      const wasPending = a.status === "pending";
      store.resolveApproval(approvalId, granted, note);
      const wi = store.getWorkItem(a.workItemId);
      store.append({
        traceId: a.workItemId,
        spanId: a.workItemId,
        parentSpanId: null,
        project: wi ? basename(wi.projectPath) : "usac",
        type: "approval.resolved",
        actor: "user",
        data: { approval_id: approvalId, granted, by: "cli" },
      });
      // Erteilte Herabstufung: nur beim Wechsel von offen auf erteilt, damit sie nie doppelt greift.
      if (wasPending && granted && applyRoutingApproval(store.getApproval(approvalId)!, overridePathFor(home), new Date())) {
        store.append({
          traceId: a.workItemId,
          spanId: a.workItemId,
          parentSpanId: null,
          project: "usac",
          type: "routing.applied",
          actor: "orchestrator",
          data: { approval_id: approvalId, ...(a.context as DowngradeSuggestion) },
        });
      }
      // Wartender Auftrag geht zurueck in die Queue; der Daemon setzt ihn im naechsten Takt fort.
      // Freigaben der Art protector blockieren nie und reihen daher nichts ein.
      if (wi && wi.status === "awaiting_approval" && a.kind !== "protector") {
        store.updateWorkItem(wi.id, { status: "queued" });
        emit(store.getWorkItem(wi.id)!, "workitem.queued", { reason: "approval", approval_id: approvalId, kind: a.kind });
      }
      return a.workItemId;
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
