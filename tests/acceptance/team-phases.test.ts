/**
 * Abnahme Phase 4, Task 7: Team-Phasen (Architect, Environment Engineer, QA, Security,
 * Verify, Charakterisierung, Spike-Bericht).
 *
 * Der Test registriert die Handler selbst (createTeamHandlers) und nutzt einen temporaeren
 * Plugin-Ordner mit eigenen Workflows und einem Stub-Gate-Profil, damit kein echtes Werkzeug
 * noetig ist. Die Preview wird ueber eine Attrappe gestartet (echte Preview nur unter POSIX).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, git, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../../packages/daemon/src/phases";
import { reviewSeats } from "../../packages/daemon/src/review";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";
import { createTeamHandlers } from "../../packages/daemon/src/team-phases";

const STUB_PROFILE = [
  "name: stub",
  'test_globs: ["spec/**", "**/*_spec.lua", "e2e/**"]',
  'protected_globs: [".usac/**", ".github/**"]',
  "acceptance:",
  '  run: "! grep -l ROT {files}"',
  "stages:",
  "  - name: unit",
  '    run: "test ! -e FAIL_UNIT"',
  "    stage: 1",
  "  - name: e2e",
  "    run: 'if [ -d e2e ]; then test -n \"$BASE_URL\" && ! grep -rl ROT e2e; fi'",
  "    stage: 3",
  "  - name: secscan",
  '    run: "echo SEC-AUSGABE-42"',
  "    stage: 4",
  "  - name: criteria",
  "    internal: criteria_evidence",
  "    stage: 6",
  "    optional: true",
  "",
].join("\n");

/** Plugin-Ordner mit Rollen, Schemas, Routing, Stub-Profil und einem Workflow fuer `type`. */
function makePlugin(type: string, phases: string[]): string {
  const plugin = mkdtempSync(join(tmpdir(), "usac-plugin-"));
  for (const d of ["agents", "schemas", "gate-profiles", "routing.yaml"]) cpSync(join(REPO_ROOT, d), join(plugin, d), { recursive: true });
  writeFileSync(join(plugin, "gate-profiles/stub.yaml"), STUB_PROFILE);
  mkdirSync(join(plugin, "workflows"));
  writeFileSync(
    join(plugin, `workflows/${type}.yaml`),
    [`name: ${type}`, "phases:", ...phases.map((p) => `  - name: ${p}`), "escalation: default", ""].join("\n"),
  );
  return plugin;
}

type Fake = { stopped: number; started: number };

function setup(opts: {
  type?: "feature" | "refactor" | "spike" | "security-fix" | "dependency-update" | "new-project";
  phases: string[];
  handlers: Record<string, Handler | Handler[]>;
  size?: "trivial" | "small" | "standard" | "large";
  budgetUsed?: () => number;
  preview?: boolean;
}) {
  const type = opts.type ?? "feature";
  const project = setupProject();
  const profile = ["name: lua-rotation", "languages: [lua]", "gate_profile: stub", "base_branch: main"];
  if (opts.preview) profile.push("preview:", '  command: "serve {port}"');
  writeFileSync(join(project, ".usac/project.yaml"), profile.join("\n") + "\n");
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner(opts.handlers);
  const fake: Fake = { stopped: 0, started: 0 };
  const team = createTeamHandlers({
    startPreview: async () => {
      fake.started++;
      return { url: "http://127.0.0.1:4711/", port: 4711, pid: 0, stop: async () => void fake.stopped++ };
    },
  });
  for (const [name, h] of Object.entries(team)) registerPhase(name, h);
  const orch = createOrchestrator({ store, runner, pluginRoot: makePlugin(type, opts.phases), home, graphify: false, budgetUsed: opts.budgetUsed });
  const submit = () => orch.submit({ projectPath: project, type, title: "Rotation umbauen", description: "Cooldowns beachten", size: opts.size });
  const events = (id: string) => store.events({ traceId: id });
  const state = (id: string) => store.getWorkItem(id)!.state as Record<string, unknown>;
  return { project, store, runner, orch, submit, events, state, fake };
}

const OPTIONS = [
  { name: "Zustandsmaschine", pros: ["klar"], cons: [] },
  { name: "Tabelle", pros: [], cons: ["starr"] },
];

const architectWithAdr: Handler = async () => ({
  output: {
    summary: "Zwei Wege",
    options: OPTIONS,
    decision: "Zustandsmaschine",
    adr: { title: "Rotation als Zustandsmaschine", context: "Cooldowns fehlen", decision: "Zustandsmaschine", consequences: "Mehr Code" },
    claims: [],
  },
});

/** Stub fuer implement: merkt sich die Rueckmeldung und beendet den Lauf. */
function stubImplement() {
  registerPhase("implement", async (wi, ctx) => {
    ctx.emit(wi, "test.implement", { lastFailure: ctx.state(wi).lastFailure, implFailures: ctx.state(wi).implFailures });
    return ctx.save(wi, { phase: "done" }, { status: "done" });
  });
}

let snapshot: PhaseSnapshot;
beforeEach(() => {
  snapshot = snapshotPhases();
});
afterEach(() => restorePhases(snapshot));

describe("Team-Phasen", () => {
  test("Fable ab 75 % nur mit Freigabe", async () => {
    const a = setup({ phases: ["setup", "design"], handlers: { architect: architectWithAdr }, size: "large", budgetUsed: () => 0.8 });
    const wi = await a.submit();
    const r1 = await a.orch.run(wi.id);
    expect(r1.status).toBe("awaiting_approval");
    expect(a.runner.calls).toHaveLength(0);
    const fable = a.store.pendingApprovals().find((x) => x.kind === "fable");
    expect(fable).toBeDefined();

    a.orch.approve(fable!.id, false, "zu teuer");
    await a.orch.run(wi.id);
    const calls = a.runner.calls.filter((c) => c.role === "architect");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("opus");
    const down = a.events(wi.id).find((e) => e.type === "model.downgraded");
    expect(down?.data).toMatchObject({ reason: "fable abgelehnt" });

    const b = setup({ phases: ["setup", "design"], handlers: { architect: architectWithAdr }, size: "large", budgetUsed: () => 0.1 });
    const wi2 = await b.submit();
    await b.orch.run(wi2.id);
    expect(b.store.pendingApprovals().some((x) => x.kind === "fable")).toBe(false);
    expect(b.runner.calls.filter((c) => c.role === "architect").map((c) => c.model)).toEqual(["fable"]);
  }, 60_000);

  test("ADR aus dem Design wird angelegt und committet", async () => {
    const t = setup({ phases: ["setup", "design"], handlers: { architect: architectWithAdr } });
    const wi = await t.submit();
    const r1 = await t.orch.run(wi.id);
    expect(r1.status).toBe("awaiting_approval");
    const design = t.store.pendingApprovals().find((x) => x.kind === "design");
    expect(design).toBeDefined();
    const adr = "docs/adr/0001-rotation-als-zustandsmaschine.md";
    expect(design!.context).toMatchObject({ decision: "Zustandsmaschine", adr });

    t.orch.approve(design!.id, true);
    const r2 = await t.orch.run(wi.id);
    expect(r2.status).toBe("done");
    const branch = `usac/${wi.id}`;
    const text = git(t.project, "show", `${branch}:${adr}`);
    expect(text).toContain("# ADR 0001: Rotation als Zustandsmaschine");
    expect(text).toContain("Zustandsmaschine");
    expect(git(t.project, "log", "-1", "--format=%s", branch)).toBe('docs: Architektur für "Rotation umbauen"');
  }, 60_000);

  test("Environment Engineer darf keine Tests ändern", async () => {
    const cheat: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, "spec/x_spec.lua"), "-- geaendert\n");
      writeFileSync(join(spec.cwd, "Makefile"), "test:\n\tbusted\n");
      return { output: { summary: "Umgebung", changed_files: ["Makefile", "spec/x_spec.lua"], claims: [] } };
    };
    const ok: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, "Makefile"), "test:\n\tbusted\n");
      return { output: { summary: "Umgebung", changed_files: ["Makefile"], claims: [] } };
    };
    const t = setup({ type: "new-project", phases: ["setup", "environment"], handlers: { "environment-engineer": [cheat, ok] } });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    const v = t.events(wi.id).find((e) => e.type === "anticheat.violation");
    expect(v?.data).toMatchObject({ role: "environment-engineer" });
    expect(JSON.stringify(v?.data)).toContain("spec/x_spec.lua");
    const wt = t.store.getWorkItem(wi.id)!.worktree!;
    expect(existsSync(join(wt, "spec/x_spec.lua"))).toBe(false);
    const branch = `usac/${wi.id}`;
    expect(git(t.project, "log", "-1", "--format=%s", branch)).toBe('chore: Umgebung für "Rotation umbauen"');
    expect(git(t.project, "show", "--name-only", "--format=", branch)).toBe("Makefile");
  }, 60_000);

  test("QA rot führt zur Implementierung zurück, Preview wird gestoppt", async () => {
    stubImplement();
    const qa: Handler = async (spec) => {
      mkdirSync(join(spec.cwd, "e2e"), { recursive: true });
      writeFileSync(join(spec.cwd, "e2e/login_spec.lua"), "-- ROT: Seite fehlt\n");
      return { output: { summary: "E2E", e2e_tests: ["e2e/login_spec.lua"], criteria: [], claims: [] } };
    };
    const t = setup({ phases: ["setup", "qa", "implement"], handlers: { "qa-engineer": qa }, preview: true });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    expect(t.fake.started).toBe(1);
    expect(t.fake.stopped).toBe(1);
    const call = t.runner.calls.find((c) => c.role === "qa-engineer")!;
    expect(call.prompt).toContain("http://127.0.0.1:4711/");
    const types = t.events(wi.id).map((e) => e.type);
    expect(types).toContain("preview.started");
    expect(types).toContain("preview.stopped");
    const impl = t.events(wi.id).find((e) => e.type === "test.implement");
    expect(String((impl?.data as { lastFailure?: string }).lastFailure)).toContain("e2e");
    // Die E2E-Tests sind committet und damit fuer den Implementer gesperrt.
    expect(git(t.project, "show", `usac/${wi.id}:e2e/login_spec.lua`)).toContain("ROT");
  }, 60_000);

  test("verify scheitert an fehlendem Kriterium-Nachweis", async () => {
    stubImplement();
    const file = "spec/acceptance/s1_spec.lua";
    registerPhase("seed", async (wi, ctx) => {
      mkdirSync(join(wi.worktree!, "spec/acceptance"), { recursive: true });
      writeFileSync(join(wi.worktree!, file), 'it("ohne Marke", function() end)\n');
      const criteria = [{ id: "AC-1", given: "a", when: "b", then: "c", source: "task" }];
      return ctx.save(wi, {
        spec: { summary: "s", title: "t", criteria, out_of_scope: [], claims: [], questions: [] },
        slices: [{ id: "S1", title: "S1", criteria: ["AC-1"], files: ["src/rotation.lua"], depends_on: [] }],
        sliceOrder: ["S1"],
        sliceTests: { S1: [file] },
        acceptanceFiles: [file],
        baseRef: await git(wi.worktree!, "rev-parse", "HEAD"),
        implFailures: 0,
      });
    });
    const t = setup({ phases: ["setup", "seed", "verify", "implement"], handlers: {} });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    const impl = t.events(wi.id).find((e) => e.type === "test.implement");
    expect(impl?.data).toMatchObject({ implFailures: 1 });
    expect(String((impl?.data as { lastFailure?: string }).lastFailure)).toContain("AC-1");
    expect(t.events(wi.id).some((e) => e.type === "gate.failed" && (e.data as { name: string }).name === "criteria")).toBe(true);
  }, 60_000);

  test("characterize lehnt roten Test ab", async () => {
    const red: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, "spec/char_spec.lua"), "-- ROT\n");
      return { output: { summary: "rot", acceptance_tests: ["spec/char_spec.lua"], claims: [] } };
    };
    const green: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, "spec/char2_spec.lua"), "-- gruen\n");
      return { output: { summary: "gruen", acceptance_tests: ["spec/char2_spec.lua"], claims: [] } };
    };
    const t = setup({ type: "refactor", phases: ["setup", "characterize"], handlers: { "test-engineer": [red, green] } });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    const types = t.events(wi.id).map((e) => e.type);
    expect(types).toContain("characterize.rejected");
    expect(types).toContain("characterize.green");
    expect(t.runner.calls.filter((c) => c.role === "test-engineer")).toHaveLength(2);
    expect(t.state(wi.id).acceptanceFiles).toEqual(["spec/char2_spec.lua"]);
    const wt = t.store.getWorkItem(wi.id)!.worktree!;
    expect(existsSync(join(wt, "spec/char_spec.lua"))).toBe(false);
  }, 60_000);

  test("Spike ändert keinen Code", async () => {
    const architect: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, "src/x.lua"), "return 1\n");
      writeFileSync(join(spec.cwd, "src/rotation.lua"), "-- kaputt\n");
      return { output: { summary: "SPIKE-BEFUND-77", options: OPTIONS, decision: "Zustandsmaschine", claims: [], questions: ["Wie viele Zauber?"] } };
    };
    const t = setup({ type: "spike", phases: ["setup", "research"], handlers: { architect } });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    const wt = t.store.getWorkItem(wi.id)!.worktree!;
    expect(existsSync(join(wt, "src/x.lua"))).toBe(false);
    expect(readFileSync(join(wt, "src/rotation.lua"), "utf8")).not.toContain("kaputt");
    const report = join(wt, `docs/spikes/${wi.id}.md`);
    expect(existsSync(report)).toBe(true);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("SPIKE-BEFUND-77");
    expect(text).toContain("Wie viele Zauber?");
    expect(t.events(wi.id).some((e) => e.type === "anticheat.violation")).toBe(true);
  }, 60_000);

  test("security: Stufe-4-Ausgabe im Prompt, high führt zur Implementierung", async () => {
    stubImplement();
    const high: Handler = async () => ({
      output: {
        verdict: "request_changes",
        summary: "unsicher",
        findings: [{ severity: "high", text: "SICHERHEITS-BEFUND", evidence: [{ type: "file", path: "src/rotation.lua", lines: [1, 1], quote: "local M = {}" }] }],
        claims: [],
      },
    });
    const t = setup({ type: "security-fix", phases: ["setup", "verify", "security", "implement"], handlers: { "security-reviewer": high } });
    const wi = await t.submit();
    const r = await t.orch.run(wi.id);
    expect(r.status).toBe("done");
    const call = t.runner.calls.find((c) => c.role === "security-reviewer")!;
    expect(call.model).toBe("opus");
    expect(call.prompt).toContain("SEC-AUSGABE-42");
    const impl = t.events(wi.id).find((e) => e.type === "test.implement");
    expect(String((impl?.data as { lastFailure?: string }).lastFailure)).toContain("SICHERHEITS-BEFUND");
  }, 60_000);

  test("security-fix hat immer einen Security-Sitz", () => {
    expect(reviewSeats("small", [], "security-fix")).toEqual([
      { role: "code-reviewer", reason: "standard" },
      { role: "security-reviewer", reason: "security" },
    ]);
    expect(reviewSeats("large", [], "security-fix").map((s) => s.role)).toEqual(["code-reviewer", "security-reviewer"]);
    expect(reviewSeats("small", [], "feature")).toEqual([{ role: "code-reviewer", reason: "standard" }]);
  });
});
