import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { z } from "zod";
import type { AcceptanceCriterion, AnalystOutput, ArchitectOutput, Claim, Finding, Model, Slice } from "@usac/shared";
import { createAdr, setAdrStatus } from "./adr";
import { matchesAny } from "./config";
import type { CriteriaEvidenceInput } from "./criteria-evidence";
import { git } from "./exec";
import { runAcceptance, runStages, type StageContext } from "./gates";
import { changedFiles, revertPaths } from "./integrity";
import { Escalate, type PhaseContext, type PhaseHandler } from "./phases";
import { startPreview as realStartPreview, type Preview } from "./preview";
import { architectPrompt, characterizePrompt, environmentPrompt, qaPrompt, researchPrompt, securityReviewerPrompt } from "./prompts";
import { resolveModel } from "./routing";
import type { GateResult, WorkItem } from "./store";
import { securityTriggers } from "./triggers";

/**
 * Phasen-Handler des erweiterten Teams (Phase 4): Architect (`design`, `research`),
 * Environment Engineer (`environment`), QA (`qa`), Gate-Stufen 3–6 (`verify`),
 * Security Reviewer (`security`) und Charakterisierung (`characterize`).
 * Alle Entscheidungen (Reihenfolge, Spruenge, Freigaben, Modellwahl) trifft dieser Code.
 */

export type TeamPhase = "design" | "environment" | "qa" | "verify" | "security" | "characterize" | "research";

export interface TeamDeps {
  /** Preview-Start; Tests ersetzen ihn durch eine Attrappe. */
  startPreview?: typeof realStartPreview;
  /** Datum fuer neue ADRs (YYYY-MM-DD). */
  today?: () => string;
}

/** Versuche des Architects je Runde (ungueltige Ausgabe zaehlt als Fehlversuch). */
export const DESIGN_ATTEMPTS = 2;
/** Hoechstzahl an Design-Runden; die dritte Ablehnung eskaliert. */
export const DESIGN_ROUNDS = 3;
/** Pfade, die der Environment Engineer nie aendern darf (zusaetzlich zu den Testdateien). */
export const ENVIRONMENT_FORBIDDEN = [".usac/**", ".github/**"];
/** Werkzeuge, die der Architect im Spike nicht nutzen darf. */
export const RESEARCH_DISALLOWED = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const DESIGN_DENIED_WITHOUT_NOTE = "Design abgelehnt ohne Begründung. Schlage andere Optionen vor oder stelle Rückfragen.";

type TeamState = {
  phase: string;
  baseRef?: string;
  implFailures?: number;
  lastFailure?: string;
  acceptanceFiles?: string[];
  spec?: AnalystOutput;
  slices?: Slice[];
  sliceOrder?: string[];
  sliceTests?: Record<string, string[]>;
  fableApprovalId?: number;
  design?: ArchitectOutput;
  adrPath?: string;
  designApprovalId?: number;
  designRounds?: number;
  designFeedback?: string;
  qaTests?: string[];
  securityGateOutput?: string;
  reportPath?: string;
  reportQuestions?: number;
  reportApprovalId?: number;
  reportRounds?: number;
  reportFeedback?: string;
  /** Umgebung der Test-Datenbank (setup im Orchestrator). */
  testDbEnv?: Record<string, string>;
};

const st = (ctx: PhaseContext, wi: WorkItem) => ctx.state(wi) as TeamState;

/** Umgebung der Test-Datenbank fuer Gates und Preview (leer ohne `test_db`). */
const dbEnv = (ctx: PhaseContext, wi: WorkItem): Record<string, string> => st(ctx, wi).testDbEnv ?? {};

/** Eine Zeile je Feld: Zeilenumbrueche wuerden Markdown und Commit-Betreff zerbrechen. */
const line = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const list = (items: string[]) => (items.length ? items.map((i) => `- ${line(i)}`).join("\n") : "- keine");

function gateEvents(ctx: PhaseContext, wi: WorkItem, results: GateResult[]) {
  for (const r of results) ctx.emit(wi, `gate.${r.status}`, { gate_result_id: r.id, name: r.name, exitCode: r.exitCode, durationMs: r.durationMs });
}

/** Commit nur, wenn etwas vorgemerkt ist; sonst null. */
async function commitStaged(ctx: PhaseContext, wi: WorkItem, message: string): Promise<string | null> {
  const staged = await git(wi.worktree!, "diff", "--cached", "--name-only");
  if (!staged) return null;
  return ctx.commit(wi.worktree!, `${message}\n\nUsac-Trace: ${wi.id}`);
}

/** Basis fuer Diffs: gesperrter Test-Commit, sonst Abzweig vom Basis-Branch. */
async function diffBase(wi: WorkItem, ctx: PhaseContext): Promise<string> {
  const s = st(ctx, wi);
  if (s.baseRef) return s.baseRef;
  try {
    return await git(wi.worktree!, "merge-base", "HEAD", ctx.profile.base_branch);
  } catch {
    return git(wi.worktree!, "rev-parse", "HEAD");
  }
}

/** Fuehrt eine Rolle aus und verwirft danach alle Dateien, die sie neu geaendert hat und nicht darf. */
async function discardForeign(wi: WorkItem, before: Set<string>, base: string, allowed: (p: string) => boolean): Promise<string[]> {
  const foreign = (await changedFiles(wi.worktree!, base)).filter((p) => !before.has(p) && !allowed(p));
  if (foreign.length) await revertPaths(wi.worktree!, base, foreign);
  return foreign;
}

/**
 * Modell des Architects. Ab der Kontingent-Schwelle braucht Fable eine blockierende Freigabe `fable`;
 * abgelehnt laeuft der Architect auf Opus (`model.downgraded`).
 */
async function architectModel(wi: WorkItem, ctx: PhaseContext): Promise<{ wi: WorkItem; model: Model } | { wait: WorkItem }> {
  const route = resolveModel(ctx.routing, "architect", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
  if (!route.needsApproval) return { wi, model: route.model };
  const { store } = ctx;
  const s = st(ctx, wi);
  let approval = s.fableApprovalId ? store.getApproval(s.fableApprovalId) : null;
  if (!approval) {
    approval = store.createApproval(wi.id, "fable", { role: "architect", model: route.model, reasons: route.reasons });
    ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "fable", reasons: route.reasons });
    wi = ctx.save(wi, { fableApprovalId: approval.id });
    if (ctx.autoApprovals.has("fable")) {
      store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
      approval = store.getApproval(approval.id)!;
    }
  }
  if (approval.status === "pending") return { wait: ctx.save(wi, {}, { status: "awaiting_approval" }) };
  wi = ctx.save(wi, {}, { status: "running" });
  if (approval.status === "denied") {
    ctx.emit(wi, "model.downgraded", { role: "architect", from: route.model, to: "opus", reason: "fable abgelehnt", approval_id: approval.id });
    return { wi, model: "opus" };
  }
  ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "fable" });
  return { wi, model: route.model };
}

function optionsBlock(options: ArchitectOutput["options"]): string {
  return options
    .map((o) => [`### ${line(o.name)}`, "", "Vorteile:", list(o.pros), "", "Nachteile:", list(o.cons)].join("\n"))
    .join("\n\n");
}

/** ADR-Inhalt aus dem Architect-Entwurf; Status bleibt Entwurf bis zur Freigabe. */
function renderAdr(number: string, wi: WorkItem, out: ArchitectOutput, today: string): string {
  const adr = out.adr!;
  return [
    `# ADR ${number}: ${line(adr.title)}`,
    "",
    "Status: Entwurf",
    `Datum: ${today}`,
    `Usac-Trace: ${wi.id}`,
    "",
    "## Kontext",
    "",
    adr.context.trim(),
    "",
    "## Optionen",
    "",
    optionsBlock(out.options),
    "",
    "## Entscheidung",
    "",
    adr.decision.trim(),
    "",
    "## Folgen",
    "",
    adr.consequences.trim(),
    "",
    "## Risiken",
    "",
    list(out.risks),
    "",
    "## Offene Fragen",
    "",
    ...out.questions.map((q) => `- ${line(q)}`),
    "",
  ].join("\n");
}

function claimLine(c: z.infer<typeof Claim>): string {
  const refs = c.evidence.map((e) =>
    e.type === "file" || e.type === "graph"
      ? `${e.path}:${e.lines[0]}-${e.lines[1]}`
      : e.type === "gate"
        ? `Gate #${e.gate_result_id}`
        : e.type === "url"
          ? e.url
          : e.type === "user"
            ? `Freigabe #${e.approval_id}`
            : `Memory ${e.id}`,
  );
  return `- [${c.level}] ${line(c.text)}${refs.length ? ` (${refs.join(", ")})` : ""}`;
}

/** Spike-Bericht deterministisch aus der Architect-Ausgabe. */
export function renderSpikeReport(wi: WorkItem, out: ArchitectOutput): string {
  return [
    `# Spike: ${line(wi.title)}`,
    `Usac-Trace: ${wi.id}`,
    line(out.summary),
    `## Befunde\n\n${out.claims.length ? out.claims.map(claimLine).join("\n") : "- keine"}`,
    `## Optionen\n\n${optionsBlock(out.options)}`,
    `## Empfehlung\n\n${line(out.decision)}`,
    `## Risiken\n\n${list(out.risks)}`,
    `## Offene Fragen\n\n${list(out.questions)}`,
  ].join("\n\n") + "\n";
}

/** Kriterien-Kontext fuer Stufe 6: je Slice ein frischer Abnahmelauf; ohne Plan ein Sammel-Slice. */
async function criteriaContext(wi: WorkItem, ctx: PhaseContext): Promise<CriteriaEvidenceInput | undefined> {
  const s = st(ctx, wi);
  if (!s.spec) return undefined;
  const criteria: AcceptanceCriterion[] = s.spec.criteria;
  const slices: Slice[] = s.slices?.length
    ? s.slices
    : [{ id: "S0", title: "Gesamt", criteria: criteria.map((c) => c.id), files: [], depends_on: [] }];
  const sliceTests: Record<string, string[]> = s.slices?.length ? { ...s.sliceTests } : { S0: s.acceptanceFiles ?? [] };
  const sliceGates: Record<string, GateResult> = {};
  for (const sl of slices) {
    const files = sliceTests[sl.id] ?? [];
    if (!files.length) continue;
    const gate = await runAcceptance(ctx.store, wi.id, ctx.gateProfile, wi.worktree!, files);
    gateEvents(ctx, wi, [gate]);
    sliceGates[sl.id] = gate;
  }
  return { cwd: wi.worktree!, criteria, slices, sliceTests, sliceGates };
}

export function createTeamHandlers(deps: TeamDeps = {}): Record<TeamPhase, PhaseHandler> {
  const startPreview = deps.startPreview ?? realStartPreview;
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));

  /** Startet die Preview, falls konfiguriert; Fehler werden als Text zurueckgegeben. */
  async function preview(wi: WorkItem, ctx: PhaseContext): Promise<{ preview?: Preview; error?: string }> {
    const cfg = ctx.profile.preview;
    if (!cfg) return {};
    try {
      const p = await startPreview({ cwd: wi.worktree!, cfg, env: dbEnv(ctx, wi), pidDir: join(ctx.home, "previews"), id: wi.id });
      ctx.emit(wi, "preview.started", { url: p.url });
      return { preview: p };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      ctx.emit(wi, "preview.failed", { reason });
      return { error: reason };
    }
  }

  async function stopPreview(wi: WorkItem, ctx: PhaseContext, p?: Preview) {
    if (!p) return;
    await p.stop();
    ctx.emit(wi, "preview.stopped", { url: p.url });
  }

  // ---- design --------------------------------------------------------------------------
  const design: PhaseHandler = async (wi, ctx) => {
    const { store } = ctx;
    let s = st(ctx, wi);
    if (s.designApprovalId) {
      const approval = store.getApproval(s.designApprovalId)!;
      if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
      if (approval.status === "granted") {
        ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "design" });
        if (s.adrPath) {
          const abs = join(wi.worktree!, s.adrPath);
          if (existsSync(abs)) {
            setAdrStatus(abs, "angenommen");
            await git(wi.worktree!, "add", "--", s.adrPath);
          }
        }
        const sha = await commitStaged(ctx, wi, `docs: Architektur für "${line(wi.title)}"`);
        ctx.emit(wi, "design.committed", { adr: s.adrPath ?? null, commit: sha });
        return ctx.save(wi, { designFeedback: undefined }, { status: "running" });
      }
      // Abgelehnt: Entwurf verwerfen und mit der Notiz neu entwerfen.
      const round = (s.designRounds ?? 0) + 1;
      ctx.emit(wi, "design.denied", { approval_id: approval.id, round, note: approval.note });
      if (round >= DESIGN_ROUNDS) throw new Escalate(`Design ${round}-mal abgelehnt: ${approval.note ?? ""}`);
      if (s.adrPath) rmSync(join(wi.worktree!, s.adrPath), { force: true });
      wi = ctx.save(
        wi,
        { design: undefined, adrPath: undefined, designApprovalId: undefined, designRounds: round, designFeedback: approval.note || DESIGN_DENIED_WITHOUT_NOTE },
        { status: "running" },
      );
      s = st(ctx, wi);
    }

    const m = await architectModel(wi, ctx);
    if ("wait" in m) return m.wait;
    wi = m.wi;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= DESIGN_ATTEMPTS; attempt++) {
      const base = await git(wi.worktree!, "rev-parse", "HEAD");
      const before = new Set(await changedFiles(wi.worktree!, base));
      const fb = [s.designFeedback, feedback].filter(Boolean).join("\n\n") || undefined;
      const res = await ctx.runRole(wi, "architect", m.model, architectPrompt(wi, s.spec, fb));
      // Der Architect schlaegt nur vor: jede Dateiaenderung wird verworfen.
      const foreign = await discardForeign(wi, before, base, () => false);
      if (foreign.length) ctx.emit(wi, "anticheat.violation", { role: "architect", paths: foreign });
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const out = res.output;
      let adrPath: string | undefined;
      if (out.adr) {
        const abs = createAdr(join(wi.worktree!, ctx.profile.adr.dir), line(out.adr.title), today());
        writeFileSync(abs, renderAdr(basename(abs).slice(0, 4), wi, out, today()));
        adrPath = relative(wi.worktree!, abs).replaceAll("\\", "/");
      }
      ctx.emit(wi, "design.proposed", { model: m.model, options: out.options.map((o) => o.name), decision: out.decision, adr: adrPath ?? null });
      const approval = store.createApproval(wi.id, "design", {
        options: out.options,
        decision: out.decision,
        adr: adrPath ?? null,
        risks: out.risks,
        questions: out.questions,
      });
      ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "design", adr: adrPath ?? null });
      wi = ctx.save(wi, { design: out, adrPath, designApprovalId: approval.id });
      if (ctx.autoApprovals.has("design") && out.questions.length === 0) {
        store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
        return design(wi, ctx); // Wiedereintritt nimmt den Zweig "erteilt"
      }
      return ctx.save(wi, {}, { status: "awaiting_approval" });
    }
    throw new Escalate(`Kein gültiger Architektur-Vorschlag nach ${DESIGN_ATTEMPTS} Versuchen`);
  };

  // ---- environment ---------------------------------------------------------------------
  const environment: PhaseHandler = async (wi, ctx) => {
    const gp = ctx.gateProfile;
    const forbidden = (p: string) => matchesAny(p, gp.test_globs) || matchesAny(p, ENVIRONMENT_FORBIDDEN);
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= ctx.limits.implementAttempts; attempt++) {
      const base = await git(wi.worktree!, "rev-parse", "HEAD");
      const route = resolveModel(ctx.routing, "environment-engineer", {
        size: wi.size,
        failures: attempt - 1,
        budgetUsed: ctx.budgetUsed(),
        available: ctx.available,
      });
      const res = await ctx.runRole(wi, "environment-engineer", route.model, environmentPrompt(wi, feedback));
      // Anti-Schummel: Tests, Projektprofil und CI bleiben unberuehrt.
      const touched = (await changedFiles(wi.worktree!, base)).filter(forbidden);
      if (touched.length) {
        await revertPaths(wi.worktree!, base, touched);
        ctx.emit(wi, "anticheat.violation", { role: "environment-engineer", paths: touched });
        feedback = `Verboten und verworfen (Testdateien, .usac/**, .github/**): ${touched.join(", ")}`;
        continue;
      }
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const stageCtx: StageContext = { workItemType: wi.type, baseRef: base, env: dbEnv(ctx, wi) };
      const run = await runStages(ctx.store, wi.id, gp, wi.worktree!, 2, stageCtx);
      gateEvents(ctx, wi, run.results);
      if (!run.passed) {
        feedback = `Gates der Stufen 1–2 sind rot:\n${run.failureOutput}`;
        continue;
      }
      await git(wi.worktree!, "add", "-A");
      const sha = await commitStaged(ctx, wi, `chore: Umgebung für "${line(wi.title)}"`);
      ctx.emit(wi, "environment.committed", { commit: sha, setup_commands: res.output.setup_commands });
      return wi;
    }
    throw new Escalate(`Umgebung nach ${ctx.limits.implementAttempts} Versuchen nicht grün`);
  };

  // ---- qa ------------------------------------------------------------------------------
  const qa: PhaseHandler = async (wi, ctx) => {
    if (!ctx.profile.preview) {
      ctx.emit(wi, "qa.skipped", { reason: "keine Preview konfiguriert" });
      return wi;
    }
    const gp = ctx.gateProfile;
    const started = await preview(wi, ctx);
    try {
      if (!started.preview) {
        return ctx.save(wi, { phase: "implement", lastFailure: `Preview startet nicht:\n${started.error ?? ""}` });
      }
      const url = started.preview.url;
      const env = { BASE_URL: url };
      let s = st(ctx, wi);
      if (!s.qaTests) {
        let feedback: string | undefined;
        let tests: string[] | undefined;
        for (let attempt = 1; attempt <= ctx.limits.acceptanceAttempts && !tests; attempt++) {
          const base = await git(wi.worktree!, "rev-parse", "HEAD");
          const before = new Set(await changedFiles(wi.worktree!, base));
          const route = resolveModel(ctx.routing, "qa-engineer", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
          const res = await ctx.runRole(wi, "qa-engineer", route.model, qaPrompt(wi, url, s.spec?.criteria, feedback), { env });
          const foreign = await discardForeign(wi, before, base, (p) => matchesAny(p, gp.test_globs));
          const missing = res.ok ? res.output.e2e_tests.filter((f) => !existsSync(join(wi.worktree!, f)) || !matchesAny(f, gp.test_globs)) : [];
          if (foreign.length || missing.length) {
            ctx.emit(wi, "anticheat.violation", { role: "qa-engineer", nonTest: foreign, missing });
            feedback = `Nur Dateien unter den Testpfaden sind erlaubt. Verworfen: ${foreign.join(", ") || "-"}. Fehlende oder ungültige Testpfade: ${missing.join(", ") || "-"}`;
            continue;
          }
          if (!res.ok) {
            feedback = res.feedback;
            continue;
          }
          tests = res.output.e2e_tests;
        }
        if (!tests) throw new Escalate(`Keine gültigen E2E-Tests nach ${ctx.limits.acceptanceAttempts} Versuchen`);
        // E2E-Tests committen: danach gelten sie fuer den Implementer als gesperrte Testdateien.
        await git(wi.worktree!, "add", "--", ...tests);
        const sha = await commitStaged(ctx, wi, `test: E2E-Tests für "${line(wi.title)}"`);
        ctx.emit(wi, "qa.tests", { files: tests, commit: sha });
        wi = ctx.save(wi, { qaTests: tests, ...(sha && s.baseRef ? { baseRef: sha } : {}) });
        s = st(ctx, wi);
      }
      const run = await runStages(ctx.store, wi.id, gp, wi.worktree!, 3, { workItemType: wi.type, baseRef: await diffBase(wi, ctx), env: { ...dbEnv(ctx, wi), ...env } }, 3);
      gateEvents(ctx, wi, run.results);
      if (!run.passed) {
        ctx.emit(wi, "qa.red", { files: s.qaTests });
        return ctx.save(wi, { phase: "implement", lastFailure: `E2E-Tests (Stufe 3) sind rot:\n${run.failureOutput}` });
      }
      ctx.emit(wi, "qa.green", { files: s.qaTests });
      return wi;
    } finally {
      await stopPreview(wi, ctx, started.preview);
    }
  };

  // ---- verify --------------------------------------------------------------------------
  const verify: PhaseHandler = async (wi, ctx) => {
    const gp = ctx.gateProfile;
    const s = st(ctx, wi);
    const fail = (text: string) => {
      ctx.emit(wi, "verify.failed", {});
      return ctx.save(wi, { phase: "implement", implFailures: (s.implFailures ?? 0) + 1, lastFailure: text });
    };
    const started = await preview(wi, ctx);
    try {
      if (started.error) return fail(`Preview startet nicht:\n${started.error}`);
      const env: Record<string, string> = { ...dbEnv(ctx, wi), ...(started.preview ? { BASE_URL: started.preview.url } : {}) };
      const criteria = await criteriaContext(wi, ctx);
      const stageCtx: StageContext = { workItemType: wi.type, baseRef: await diffBase(wi, ctx), env, ...(criteria ? { criteria } : {}) };
      const run = await runStages(ctx.store, wi.id, gp, wi.worktree!, 6, stageCtx, 3);
      gateEvents(ctx, wi, run.results);
      // Ausgaben der Stufe-4-Gates fuer den Security Reviewer.
      const stage4 = new Set(gp.stages.filter((x) => x.stage === 4).map((x) => x.name));
      const securityGateOutput = run.results
        .filter((r) => stage4.has(r.name))
        .map((r) => `### ${r.name} (${r.status}, Exit ${r.exitCode})\n${r.output}`)
        .join("\n\n");
      if (!run.passed) return fail(`Verify (Stufen 3–6) ist rot:\n${run.failureOutput}`);
      ctx.emit(wi, "verify.passed", { gates: run.results.map((r) => ({ name: r.name, status: r.status })) });
      return ctx.save(wi, { securityGateOutput: securityGateOutput || undefined });
    } finally {
      await stopPreview(wi, ctx, started.preview);
    }
  };

  // ---- security ------------------------------------------------------------------------
  const security: PhaseHandler = async (wi, ctx) => {
    const s = st(ctx, wi);
    const base = await diffBase(wi, ctx);
    await git(wi.worktree!, "add", "-A");
    const diff = await git(wi.worktree!, "diff", "--cached", base);
    const changed = (await git(wi.worktree!, "diff", "--cached", "--name-only", base)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const triggers = securityTriggers(changed, diff);
    const route = resolveModel(ctx.routing, "security-reviewer", { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
    if (route.model === "fable") throw new Error("Fable im Security-Review ist nicht erlaubt (ADR 0004)");
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= ctx.limits.reviewAttempts; attempt++) {
      const res = await ctx.runRole(wi, "security-reviewer", route.model, securityReviewerPrompt(wi, diff, triggers, feedback, s.securityGateOutput));
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const findings: z.infer<typeof Finding>[] = res.output.findings;
      ctx.emit(wi, "security.review", { model: route.model, verdict: res.output.verdict, triggers, findings });
      const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high");
      if (!blocking.length) return wi;
      const lines = blocking.map((f) => `- (security-reviewer) [${f.severity}] ${f.text}`);
      return ctx.save(wi, { phase: "implement", lastFailure: "Security-Befunde:\n" + lines.join("\n") });
    }
    throw new Escalate(`Security-Review lieferte nach ${ctx.limits.reviewAttempts} Versuchen keine gültige Ausgabe`);
  };

  // ---- characterize --------------------------------------------------------------------
  const characterize: PhaseHandler = async (wi, ctx) => {
    const gp = ctx.gateProfile;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= ctx.limits.acceptanceAttempts; attempt++) {
      const base = await git(wi.worktree!, "rev-parse", "HEAD");
      const before = new Set(await changedFiles(wi.worktree!, base));
      const route = resolveModel(ctx.routing, "test-engineer", {
        variant: ctx.spec.variant ?? "acceptance",
        size: wi.size,
        budgetUsed: ctx.budgetUsed(),
        available: ctx.available,
      });
      const res = await ctx.runRole(wi, "test-engineer", route.model, characterizePrompt(wi, feedback));
      const own = async () => (await changedFiles(wi.worktree!, base)).filter((p) => !before.has(p));
      const nonTest = await discardForeign(wi, before, base, (p) => matchesAny(p, gp.test_globs));
      const files = res.ok ? res.output.acceptance_tests : [];
      const missing = files.filter((f) => !existsSync(join(wi.worktree!, f)) || !matchesAny(f, gp.test_globs));
      if (nonTest.length || missing.length) {
        ctx.emit(wi, "anticheat.violation", { role: "test-engineer", nonTest, missing });
        feedback = `Nur Testdateien sind erlaubt. Verworfen: ${nonTest.join(", ") || "-"}. Fehlende oder ungültige Testpfade: ${missing.join(", ") || "-"}`;
        continue;
      }
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const gate = await runAcceptance(ctx.store, wi.id, gp, wi.worktree!, files);
      gateEvents(ctx, wi, [gate]);
      if (gate.status !== "passed") {
        ctx.emit(wi, "characterize.rejected", { reason: "Charakterisierungstest ist mit dem aktuellen Code rot", files, gate_result_id: gate.id });
        await revertPaths(wi.worktree!, base, await own());
        feedback = `Dein Charakterisierungstest war rot. Er muss das heutige Verhalten festhalten und daher mit dem aktuellen Code grün sein.\n${gate.output.slice(0, 4000)}`;
        continue;
      }
      ctx.emit(wi, "characterize.green", { files, gate_result_id: gate.id });
      return ctx.save(wi, { acceptanceFiles: files });
    }
    throw new Escalate(`Kein grüner Charakterisierungstest nach ${ctx.limits.acceptanceAttempts} Versuchen`);
  };

  // ---- research ------------------------------------------------------------------------
  const research: PhaseHandler = async (wi, ctx) => {
    const s = st(ctx, wi);
    if (s.reportPath && existsSync(join(wi.worktree!, s.reportPath))) return wi; // Resume: Bericht steht schon
    const m = await architectModel(wi, ctx);
    if ("wait" in m) return m.wait;
    wi = m.wi;
    const reportPath = `docs/spikes/${wi.id}.md`;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= DESIGN_ATTEMPTS; attempt++) {
      const base = await git(wi.worktree!, "rev-parse", "HEAD");
      const before = new Set(await changedFiles(wi.worktree!, base));
      // Notiz einer Ablehnung des Berichts (approve_report) bleibt erhalten, auch bei Schema-Fehlern.
      const fb = [s.reportFeedback, feedback].filter(Boolean).join("\n\n") || undefined;
      const res = await ctx.runRole(wi, "architect", m.model, researchPrompt(wi, fb), { disallowedTools: RESEARCH_DISALLOWED });
      // Spike aendert keinen Code: alles ausser dem (vom Orchestrator gerenderten) Bericht wird verworfen.
      const foreign = await discardForeign(wi, before, base, () => false);
      if (foreign.length) ctx.emit(wi, "anticheat.violation", { role: "architect", phase: "research", paths: foreign });
      if (!res.ok) {
        feedback = res.feedback;
        continue;
      }
      const abs = join(wi.worktree!, reportPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, renderSpikeReport(wi, res.output));
      ctx.emit(wi, "spike.report", { path: reportPath, model: m.model, questions: res.output.questions.length });
      return ctx.save(wi, { reportPath, reportQuestions: res.output.questions.length, reportFeedback: undefined });
    }
    throw new Escalate(`Kein gültiger Spike-Bericht nach ${DESIGN_ATTEMPTS} Versuchen`);
  };

  return { design, environment, qa, verify, security, characterize, research };
}

/** Hoechstzahl an Berichts-Runden im Spike; die dritte Ablehnung eskaliert. */
export const REPORT_ROUNDS = 3;
const REPORT_DENIED_WITHOUT_NOTE = "Bericht abgelehnt ohne Begründung. Prüfe Befunde und Optionen erneut und stelle Rückfragen.";

/**
 * Freigabe `report` des Spike-Berichts (wie `approve_spec`): erteilt → weiter (Commit in `integrate`),
 * abgelehnt → Bericht verwerfen und `research` mit der Notiz neu starten; die dritte Ablehnung eskaliert.
 * Offene Fragen im Bericht brauchen immer einen Menschen, auch bei automatischer Freigabe.
 */
export const approveReport: PhaseHandler = async (wi, ctx) => {
  const { store } = ctx;
  const s = st(ctx, wi);
  if (!s.reportPath) throw new Error("approve_report ohne Bericht im Zustand");
  let approval = s.reportApprovalId ? store.getApproval(s.reportApprovalId) : null;
  if (!approval) {
    approval = store.createApproval(wi.id, "report", { path: s.reportPath, title: wi.title });
    ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "report", path: s.reportPath });
    wi = ctx.save(wi, { reportApprovalId: approval.id });
    if (ctx.autoApprovals.has("report") && !s.reportQuestions) {
      store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
      approval = store.getApproval(approval.id)!;
    }
  }
  if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
  if (approval.status === "denied") {
    const round = (s.reportRounds ?? 0) + 1;
    ctx.emit(wi, "report.denied", { approval_id: approval.id, round, note: approval.note });
    if (round >= REPORT_ROUNDS) throw new Escalate(`Bericht ${round}-mal abgelehnt: ${approval.note ?? ""}`);
    rmSync(join(wi.worktree!, s.reportPath), { force: true });
    return ctx.save(
      wi,
      { phase: "research", reportPath: undefined, reportApprovalId: undefined, reportRounds: round, reportFeedback: approval.note || REPORT_DENIED_WITHOUT_NOTE },
      { status: "running" },
    );
  }
  ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "report" });
  return ctx.save(wi, {}, { status: "running" });
};
