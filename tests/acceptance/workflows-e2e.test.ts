/**
 * Abnahme Phase 4, Task 9: jeder Workflow laeuft von Anfang bis Ende (bis merge).
 *
 * Alle Phasen kommen aus orchestrator.ts und registry-setup.ts; ersetzt werden nur die
 * Integrator-Befehle (Attrappen fuer `git push` und `gh`, kein Netz). Rollen laufen per
 * ScriptedRunner. Das Gate-Profil `lua` des temporaeren Plugin-Ordners ist ein Stub ohne
 * echte Werkzeuge; gitleaks ist ein Stub-Skript in einem eigenen Ordner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, git, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import "../../packages/daemon/src/registry-setup";
import { createIntegratorHandlers, realGit, type CmdResult, type GitRunner } from "../../packages/daemon/src/integrator";
import { missingPhases, registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../../packages/daemon/src/phases";
import { RESEARCH_DISALLOWED } from "../../packages/daemon/src/team-phases";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";
import { loadWorkflow } from "../../packages/daemon/src/workflow";

type Type = "new-project" | "change" | "refactor" | "dependency-update" | "security-fix" | "spike" | "bugfix" | "feature";

/** Stub-Profil: rot ist ein Test mit "ROT", bis die Implementierung src/impl.txt anlegt. */
function stubProfile(stubDir: string): string {
  return [
    "name: lua",
    'test_globs: ["spec/**", "**/*_spec.lua"]',
    'protected_globs: [".usac/**", ".github/**"]',
    "acceptance:",
    "  run: 'if grep -l ROT {files} >/dev/null; then test -e src/impl.txt; fi'",
    "stages:",
    "  - name: unit",
    '    run: "test ! -e FAIL_UNIT"',
    "    stage: 1",
    "  - name: gitleaks",
    `    run: '"${stubDir.replaceAll("\\", "/")}/gitleaks" git --log-opts="{base}..HEAD"'`,
    "    stage: 4",
    "    optional: true",
    "    required_in: [security-fix, dependency-update]",
    "  - name: criteria",
    "    internal: criteria_evidence",
    "    stage: 6",
    "    optional: true",
    "",
  ].join("\n");
}

function makePlugin(stubDir: string): string {
  const plugin = mkdtempSync(join(tmpdir(), "usac-plugin-"));
  for (const d of ["agents", "schemas", "gate-profiles", "workflows", "routing.yaml"]) cpSync(join(REPO_ROOT, d), join(plugin, d), { recursive: true });
  writeFileSync(join(plugin, "gate-profiles/lua.yaml"), stubProfile(stubDir));
  return plugin;
}

function writeStub(stubDir: string) {
  const p = join(stubDir, "gitleaks");
  writeFileSync(p, "#!/bin/sh\necho gitleaks-stub ok\nexit 0\n");
  chmodSync(p, 0o755);
}

const write = (cwd: string, file: string, text: string) => {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
};

const criteria = [{ id: "AC-1", given: "ein Zauber auf Cooldown", when: "next_spell laeuft", then: "wird er uebersprungen", source: "task" }];
const OPTIONS = [
  { name: "Zustandsmaschine", pros: ["klar"], cons: [] },
  { name: "Tabelle", pros: [], cons: ["starr"] },
];

const analyst: Handler = async () => ({
  output: { summary: "Cooldowns beachten", title: "Cooldown-Rotation", criteria, out_of_scope: [], claims: [], questions: [] },
});
const architect: Handler = async () => ({
  output: {
    summary: "Zwei Wege",
    options: OPTIONS,
    decision: "Zustandsmaschine",
    adr: { title: "Rotation als Zustandsmaschine", context: "Cooldowns fehlen", decision: "Zustandsmaschine", consequences: "Mehr Code" },
    claims: [],
  },
});
const environmentEngineer: Handler = async (spec) => {
  write(spec.cwd, "VERSIONS.txt", "werkzeug 2.0\n");
  return { output: { summary: "Umgebung", changed_files: ["VERSIONS.txt"], setup_commands: ["make"], claims: [] } };
};
const techLead: Handler = async () => ({
  output: {
    summary: "Ein Slice",
    size: "small",
    slices: [{ id: "S1", title: "Cooldown", criteria: ["AC-1"], files: ["src/impl.txt"], depends_on: [] }],
    claims: [],
    questions: [],
  },
});
const ACC = "spec/acceptance/cooldown_spec.lua";
const testEngineerRed: Handler = async (spec) => {
  write(spec.cwd, ACC, 'it("[AC-1] ROT: Cooldown wird beachtet", function() end)\n');
  return { output: { summary: "rot", acceptance_tests: [ACC], claims: [] } };
};
const CHAR = "spec/char_spec.lua";
const testEngineerGreen: Handler = async (spec) => {
  write(spec.cwd, CHAR, 'it("haelt das heutige Verhalten fest", function() end)\n');
  return { output: { summary: "gruen", acceptance_tests: [CHAR], claims: [] } };
};
const implementer: Handler = async (spec) => {
  write(spec.cwd, "src/impl.txt", "umgesetzt\n");
  return { output: { summary: "umgesetzt", changed_files: ["src/impl.txt"], claims: [] } };
};
const approve: Handler = async () => ({ output: { verdict: "approve", summary: "ok", findings: [], claims: [] } });
const spikeArchitect: Handler = async () => ({
  output: { summary: "SPIKE-BEFUND", options: OPTIONS, decision: "Zustandsmaschine", claims: [], questions: [] },
});

const ROLES: Record<string, Handler> = {
  analyst,
  architect,
  "environment-engineer": environmentEngineer,
  "tech-lead": techLead,
  "test-engineer": testEngineerRed,
  implementer,
  "code-reviewer": approve,
  "security-reviewer": approve,
};

type GhCall = string[];

function setup(opts: { type: Type; roles?: Record<string, Handler>; stub?: boolean; project?: string; profileExtra?: string[]; size?: "small" | "large" }) {
  const stubDir = mkdtempSync(join(tmpdir(), "usac-stub-"));
  if (opts.stub !== false) writeStub(stubDir);
  const plugin = makePlugin(stubDir);
  const project = opts.project ?? setupProject();
  if (opts.profileExtra) {
    const p = join(project, ".usac/project.yaml");
    writeFileSync(p, readFileSync(p, "utf8").trimEnd() + "\n" + opts.profileExtra.join("\n") + "\n");
    git(project, "add", "-A");
    git(project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "chore: Profil");
  }
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner({ ...ROLES, ...opts.roles });
  // Attrappen: push ohne Remote, gh ohne Netz; Aufrufe werden protokolliert.
  const gh: GhCall[] = [];
  const pushGit: GitRunner = async (cwd, args) => (args[0] === "push" ? { exitCode: 0, output: "" } : realGit(cwd, args));
  const ghRun = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    gh.push(args);
    if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, output: "https://github.com/x/y/pull/1" };
    if (args[0] === "pr" && args[1] === "view") return { exitCode: 1, output: "" };
    return { exitCode: 0, output: "" };
  };
  const h = createIntegratorHandlers({ git: pushGit, gh: ghRun });
  registerPhase("push", h.push);
  registerPhase("pr", h.pr);
  registerPhase("approve_h2", h.approve_h2);
  registerPhase("merge", h.merge);
  const orch = createOrchestrator({ store, runner, pluginRoot: plugin, home, approvals: { auto: ["spec", "h1"] }, graphify: false });
  const events = (id: string) => store.events({ traceId: id });
  const types = (id: string) => events(id).map((e) => e.type);

  /** Laeuft bis zum Ende; Freigaben design, report und h2 erteilt der Test. */
  async function runToEnd(title = "Rotation umbauen") {
    const wi = await orch.submit({ projectPath: project, type: opts.type, title, description: "Cooldowns beachten", size: opts.size });
    let r = await orch.run(wi.id);
    const granted: string[] = [];
    for (let i = 0; i < 10 && r.status === "awaiting_approval"; i++) {
      const pending = store.pendingApprovals().filter((a) => a.workItemId === wi.id && a.kind !== "protector");
      expect(pending.length).toBe(1);
      granted.push(pending[0]!.kind);
      orch.approve(pending[0]!.id, true);
      r = await orch.run(wi.id);
    }
    return { wi, r, granted };
  }
  return { project, store, runner, orch, gh, events, types, runToEnd };
}

/** Prueft, dass die Ereignisse in genau dieser Reihenfolge vorkommen. */
function expectOrder(types: string[], order: string[]) {
  const idx = order.map((t) => types.indexOf(t));
  for (let i = 0; i < order.length; i++) expect({ event: order[i], index: idx[i]! >= 0 }).toEqual({ event: order[i], index: true });
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
}

const merged = (gh: GhCall[]) => gh.some((a) => a[0] === "pr" && a[1] === "merge");

let snapshot: PhaseSnapshot;
beforeEach(() => {
  snapshot = snapshotPhases();
});
afterEach(() => restorePhases(snapshot));

describe("Durchläufe je Workflow", () => {
  test("jede Phase hat einen Handler", () => {
    const files = readdirSync(join(REPO_ROOT, "workflows")).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBe(8);
    for (const f of files) expect({ f, missing: missingPhases(loadWorkflow(join(REPO_ROOT, "workflows", f))) }).toEqual({ f, missing: [] });
  });

  test("new-project läuft bis merge", async () => {
    const parent = mkdtempSync(join(tmpdir(), "usac-new-"));
    const dir = join(parent, "neues-projekt");
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/daemon/src/cli.ts"), "new-project", dir, "--stack", "lua"], {
      env: { ...process.env, USAC_HOME: tempHome() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain(dir);
    expect(readFileSync(join(dir, ".usac/project.yaml"), "utf8")).toContain("gate_profile: lua");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(dir, "log", "--format=%s")).not.toBe("");
    expect(git(dir, "remote")).toBe("");

    const t = setup({ type: "new-project", project: dir });
    const { wi, r, granted } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(granted).toEqual(["design", "h2"]);
    expect(merged(t.gh)).toBe(true);
    expectOrder(t.types(wi.id), ["spec.committed", "design.committed", "environment.committed", "plan.created", "acceptance.red", "acceptance.green", "verify.passed", "review.approved", "merged"]);
  }, 120_000);

  test("change läuft bis merge", async () => {
    const t = setup({ type: "change" });
    const { wi, r } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(merged(t.gh)).toBe(true);
    const types = t.types(wi.id);
    expect(types).not.toContain("plan.created");
    expect(t.runner.calls.some((c) => c.role === "tech-lead")).toBe(false);
    expectOrder(types, ["spec.committed", "acceptance.red", "acceptance.green", "verify.passed", "review.approved", "merged"]);
    // Ohne Preview wird qa uebersprungen und gemeldet.
    const skipped = t.events(wi.id).filter((e) => e.type === "phase.skipped").map((e) => e.data as { name: string; reason: string });
    expect(skipped.map((s) => s.name)).toEqual(["qa"]);
    expect(skipped[0]!.reason).toContain("Preview");
    // Ohne Plan: der Test Engineer bekommt alle Kriterien und muss sie markieren (Stufe 6).
    const te = t.runner.calls.find((c) => c.role === "test-engineer")!;
    expect(te.prompt).toContain("[AC-n]");
    expect(te.prompt).toContain("AC-1");
    const crit = t.events(wi.id).find((e) => e.type === "gate.passed" && (e.data as { name: string }).name === "criteria");
    expect(crit).toBeDefined();
  }, 120_000);

  test("refactor läuft bis merge", async () => {
    const t = setup({ type: "refactor", roles: { "test-engineer": testEngineerGreen } });
    const { wi, r } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(merged(t.gh)).toBe(true);
    const types = t.types(wi.id);
    expect(types).not.toContain("acceptance.red");
    expectOrder(types, ["characterize.green", "test.locked", "acceptance.green", "verify.passed", "review.approved", "merged"]);
  }, 120_000);

  test("dependency-update läuft bis merge", async () => {
    const t = setup({ type: "dependency-update" });
    const { wi, r } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(merged(t.gh)).toBe(true);
    const leaks = t.events(wi.id).filter((e) => (e.data as { name?: string }).name === "gitleaks").map((e) => e.type);
    expect(leaks).toEqual(["gate.passed"]);
    expectOrder(t.types(wi.id), ["environment.committed", "verify.passed", "security.review", "review.approved", "merged"]);
  }, 120_000);

  test("dependency-update ohne gitleaks scheitert und eskaliert", async () => {
    const t = setup({ type: "dependency-update", stub: false });
    const { wi, r } = await t.runToEnd();
    expect(r.status).toBe("escalated");
    expect(merged(t.gh)).toBe(false);
    const leaks = t.events(wi.id).filter((e) => (e.data as { name?: string }).name === "gitleaks").map((e) => e.type);
    expect(leaks).toEqual(["gate.failed"]);
    expect(t.types(wi.id)).toContain("workitem.escalated");
  }, 120_000);

  test("security-fix läuft bis merge", async () => {
    const t = setup({ type: "security-fix" });
    const { wi, r } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(merged(t.gh)).toBe(true);
    expectOrder(t.types(wi.id), ["acceptance.red", "acceptance.green", "verify.passed", "security.review", "review.approved", "merged"]);
    const seats = t.events(wi.id).filter((e) => e.type === "review.seat").map((e) => (e.data as { role: string }).role);
    expect(seats).toContain("security-reviewer");
  }, 120_000);

  test("spike läuft bis merge", async () => {
    const t = setup({ type: "spike", roles: { architect: spikeArchitect } });
    const { wi, r, granted } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(granted).toEqual(["report", "h2"]);
    expect(merged(t.gh)).toBe(true);
    const branch = `usac/${wi.id}`;
    expect(git(t.project, "diff", "--name-only", `main...${branch}`)).toBe(`docs/spikes/${wi.id}.md`);
    expect(git(t.project, "show", `${branch}:docs/spikes/${wi.id}.md`)).toContain("SPIKE-BEFUND");
    // Der Architect bekommt im Spike keine Schreibwerkzeuge.
    const call = t.runner.calls.find((c) => c.role === "architect")!;
    expect(call.disallowedTools).toEqual(RESEARCH_DISALLOWED);
  }, 120_000);

  test("design läuft nur bei großen Aufträgen", async () => {
    const t = setup({ type: "feature", size: "large" });
    const { wi, r, granted } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(granted).toEqual(["design", "h2"]);
    expect(t.types(wi.id)).toContain("design.committed");

    const s = setup({ type: "feature", size: "small" });
    const small = await s.runToEnd();
    expect(small.r.status).toBe("done");
    expect(small.granted).toEqual(["h2"]);
    expect(s.runner.calls.some((c) => c.role === "architect")).toBe(false);
    const skipped = s.events(small.wi.id).filter((e) => e.type === "phase.skipped").map((e) => e.data as { name: string; reason: string });
    expect(skipped.map((x) => x.name)).toEqual(["design", "qa"]);
    expect(skipped[0]!.reason).toContain("small");
  }, 120_000);

  test("Test-DB wird nach dem Lauf gelöscht", async () => {
    let seen: { url?: string; exists?: boolean } = {};
    const impl: Handler = async (spec, n) => {
      const url = spec.env?.DATABASE_URL;
      seen = { url, exists: url ? existsSync(url.replace(/^file:/, "")) : false };
      return implementer(spec, n);
    };
    const t = setup({ type: "bugfix", roles: { implementer: impl }, profileExtra: ["test_db:", "  kind: sqlite"] });
    const { wi, r } = await t.runToEnd();
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(seen.url).toStartWith("file:");
    expect(seen.exists).toBe(true);
    expect(existsSync(seen.url!.replace(/^file:/, ""))).toBe(false);
    expect(t.types(wi.id)).toContain("testdb.dropped");
  }, 120_000);
});
