/**
 * Abnahme Phase 2, Task 7: Leases serialisieren Runs auf denselben Dateien.
 * Zwei Auftraege im selben Projekt teilen sich Store und Scheduler; jeder hat eigenen Runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, git, setupProject, tempHome } from "../helpers";
import { leasesOf } from "../../packages/daemon/src/leases";
import { createOrchestrator, type Orchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../../packages/daemon/src/phases";
import { createIntegratorHandlers, realGit, type CmdResult, type GitRunner } from "../../packages/daemon/src/integrator";
import { createScheduler } from "../../packages/daemon/src/scheduler";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore, type Store } from "../../packages/daemon/src/store";

const OTHER_SPEC = `local other = require("other")

describe("Abnahme: other", function()
  it("liefert true", function()
    assert.is_true(other.ok())
  end)
end)
`;

const OTHER_SRC = `local M = {}

--- Liefert immer true.
-- @return boolean
function M.ok()
  return true
end

return M
`;

type Plan = { file: string; acc: string; spec: string; impl: string };
const ROTATION: Plan = { file: "src/rotation.lua", acc: "spec/acceptance/a_spec.lua", spec: ACCEPTANCE_SPEC, impl: FIXED_ROTATION };
const ROTATION_B: Plan = { ...ROTATION, acc: "spec/acceptance/b_spec.lua" };
const OTHER: Plan = { file: "src/other.lua", acc: "spec/acceptance/other_spec.lua", spec: OTHER_SPEC, impl: OTHER_SRC };

function runnerFor(plan: Plan, gate?: Promise<void>, implementer?: Handler) {
  const te: Handler = async (spec) => {
    mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
    writeFileSync(join(spec.cwd, plan.acc), plan.spec);
    return { output: { summary: "Test geschrieben", acceptance_tests: [plan.acc], claims: [] } };
  };
  const impl: Handler = async (spec) => {
    if (gate) await gate;
    writeFileSync(join(spec.cwd, plan.file), plan.impl);
    return { output: { summary: "umgesetzt", changed_files: [plan.file], claims: [] } };
  };
  const rev: Handler = async () => ({ output: { verdict: "approve", summary: "ok", findings: [], claims: [] } });
  return new ScriptedRunner({ "test-engineer": te, implementer: implementer ?? impl, "code-reviewer": rev });
}

const criteria = [{ id: "AC-1", given: "g", when: "w", then: "t", source: "task" }];

/** Plaene je Titel: der Titel waehlt die Datei des Slices. */
const plans: Record<string, Plan> = {};

let snapshot: PhaseSnapshot;
beforeEach(() => {
  snapshot = snapshotPhases();
  registerPhase("spec", async (wi, ctx) =>
    ctx.save(wi, { spec: { summary: "s", title: wi.title, criteria, out_of_scope: [], claims: [], questions: [] } }),
  );
  registerPhase("approve_spec", async (wi) => wi);
  registerPhase("plan", async (wi, ctx) =>
    ctx.save(wi, {
      slices: [{ id: "S1", title: "s", criteria: ["AC-1"], files: [plans[wi.title]!.file], depends_on: [] }],
      sliceOrder: ["S1"],
    }),
  );
  // Attrappen: push ohne Remote, gh ohne Netz.
  const git: GitRunner = async (cwd, args) => (args[0] === "push" ? { exitCode: 0, output: "" } : realGit(cwd, args));
  let pr = 0;
  const gh = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, output: `https://github.com/x/y/pull/${++pr}` };
    if (args[0] === "pr" && args[1] === "view") return { exitCode: 1, output: "" };
    return { exitCode: 0, output: "" };
  };
  const h = createIntegratorHandlers({ git, gh });
  registerPhase("push", h.push);
  registerPhase("pr", h.pr);
  registerPhase("approve_h2", h.approve_h2);
  registerPhase("merge", h.merge);
});
afterEach(() => restorePhases(snapshot));

function setup() {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const orchs = new Map<string, Orchestrator>();
  const make = (plan: Plan, title: string, gate?: Promise<void>, implementer?: Handler) => {
    plans[title] = plan;
    return createOrchestrator({ store, runner: runnerFor(plan, gate, implementer), pluginRoot: REPO_ROOT, home, approvals: { auto: ["h1"] }, graphify: false });
  };
  const submit = async (plan: Plan, title: string, type: "feature" | "bugfix" = "feature", gate?: Promise<void>, implementer?: Handler) => {
    const orch = make(plan, title, gate, implementer);
    const wi = await orch.submit({ projectPath: project, type, title, description: "x" });
    orchs.set(wi.id, orch);
    return { wi, orch };
  };
  const sched = createScheduler({ store, run: (id) => orchs.get(id)!.run(id, { slotHeld: true }) });
  return { project, store, submit, sched };
}

const types = (store: Store, id: string) => store.events({ traceId: id }).map((e) => e.type);

describe("Leases im Orchestrator (Abnahme)", () => {
  test("zwei Runs auf derselben Datei werden serialisiert", async () => {
    const { store, submit, sched } = setup();
    const a = await submit(ROTATION, "A rotation");
    const b = await submit(ROTATION_B, "B rotation");

    const ra = await a.orch.run(a.wi.id);
    expect(ra.reason).toBeUndefined();
    expect(ra.status).toBe("awaiting_approval");
    const h2 = store.pendingApprovals().find((x) => x.workItemId === a.wi.id && x.kind === "h2")!;
    expect(h2).toBeDefined();

    sched.enqueue(b.wi.id);
    expect(await sched.tick()).toEqual([b.wi.id]);
    await sched.idle();
    const bEvents = store.events({ traceId: b.wi.id });
    const wait = bEvents.find((e) => e.type === "lease.wait");
    expect(wait).toBeDefined();
    expect((wait!.data as { conflicts: { path: string; holder: string }[] }).conflicts).toContainEqual({ path: "src/rotation.lua", holder: a.wi.id });
    expect(store.getWorkItem(b.wi.id)!.status).toBe("queued");
    expect((store.getWorkItem(b.wi.id)!.state as { phase: string }).phase).toBe("lock");
    expect(types(store, b.wi.id)).not.toContain("test.locked");

    a.orch.approve(h2.id, true);
    // Die Freigabe reiht A wieder ein; der Scheduler wuerde A im naechsten Takt starten.
    expect(store.getWorkItem(a.wi.id)!.status).toBe("queued");
    const ra2 = await a.orch.run(a.wi.id);
    expect(ra2.reason).toBeUndefined();
    expect(ra2.status).toBe("done");

    expect(await sched.tick()).toEqual([b.wi.id]);
    await sched.idle();
    expect(types(store, b.wi.id)).toContain("test.locked");
    expect(store.getWorkItem(b.wi.id)!.status).toBe("awaiting_approval");
  }, 120_000);

  test("verschiedene Dateien laufen parallel", async () => {
    const { store, submit } = setup();
    const a = await submit(ROTATION, "A rotation");
    const b = await submit(OTHER, "B other");
    const [ra, rb] = await Promise.all([a.orch.run(a.wi.id), b.orch.run(b.wi.id)]);
    expect(ra.reason).toBeUndefined();
    expect(rb.reason).toBeUndefined();
    for (const id of [a.wi.id, b.wi.id]) {
      expect(types(store, id)).toContain("test.locked");
      expect(types(store, id)).not.toContain("lease.wait");
    }
  }, 120_000);

  test("Implementer: belegte Dateien werden zurueckgesetzt, freie nachtraeglich genommen", async () => {
    const { store, submit } = setup();
    const b = await submit(OTHER, "B other");
    expect((await b.orch.run(b.wi.id)).status).toBe("awaiting_approval"); // haelt src/other.lua
    const prompts: string[] = [];
    const greedy: Handler = async (spec, n) => {
      prompts.push(spec.prompt);
      writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
      writeFileSync(join(spec.cwd, "src/extra.lua"), "return {}\n");
      if (n === 0) writeFileSync(join(spec.cwd, "src/other.lua"), OTHER_SRC);
      return { output: { summary: "umgesetzt", changed_files: ["src/rotation.lua", "src/extra.lua"], claims: [] } };
    };
    const a = await submit(ROTATION, "A rotation", "feature", undefined, greedy);
    const ra = await a.orch.run(a.wi.id);
    expect(ra.reason).toBeUndefined();
    expect(ra.status).toBe("awaiting_approval");

    const ev = store.events({ traceId: a.wi.id });
    expect(ev.filter((e) => e.type === "lease.extended").map((e) => (e.data as { path: string }).path)).toEqual(["src/extra.lua"]);
    expect(ev.some((e) => e.type === "lease.conflict")).toBe(true);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain(`Datei src/other.lua ist von ${b.wi.id} belegt`);
    // B haelt src/other.lua weiter; A hat die Datei nicht im Commit.
    expect(leasesOf(store, b.wi.id)).toContain("src/other.lua");
    expect(leasesOf(store, a.wi.id)).toContain("src/extra.lua");
    expect(git(store.getWorkItem(a.wi.id)!.worktree!, "show", "--name-only", "--format=", "HEAD")).not.toContain("src/other.lua");
  }, 120_000);

  test("bugfix sperrt das Projekt", async () => {
    const { store, submit } = setup();
    // A haelt im Implementer (nach lock) an, bis B an lock gescheitert ist.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await submit(ROTATION, "A bugfix", "bugfix", gate);
    const b = await submit(OTHER, "B bugfix", "bugfix");
    const pa = a.orch.run(a.wi.id);
    while (!types(store, a.wi.id).includes("test.locked")) {
      if (types(store, a.wi.id).some((t) => t === "workitem.failed" || t === "workitem.escalated")) break;
      await Bun.sleep(25);
    }
    expect(types(store, a.wi.id)).toContain("test.locked");

    const rb = await b.orch.run(b.wi.id);
    expect(rb.status).toBe("queued");
    const wait = store.events({ traceId: b.wi.id }).find((e) => e.type === "lease.wait");
    expect(wait).toBeDefined();
    expect((wait!.data as { conflicts: { path: string; holder: string }[] }).conflicts).toContainEqual({ path: "*", holder: a.wi.id });

    release();
    const ra = await pa;
    expect(ra.reason).toBeUndefined();
    expect(ra.status).toBe("done");
  }, 120_000);
});
