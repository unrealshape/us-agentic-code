/**
 * Abnahme Phase 1b, Task 5: roter Test je Slice, gruener Nachweis je Slice.
 *
 * spec/approve_spec/plan sind hier Test-Handler; plan schreibt zwei Slices
 * S1 (AC-1) und S2 (AC-2, haengt von S1 ab) in den Zustand. Der Workflow endet
 * nach implement, damit der Test ohne Integrator auskommt.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../../packages/daemon/src/phases";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";

const S1_FILE = "spec/acceptance/s1_cooldown_spec.lua";
const S2_FILE = "spec/acceptance/s2_nil_spec.lua";

/** Rot mit dem Ausgangscode, gruen mit FIXED_ROTATION. */
const S2_SPEC = `local rotation = require("rotation")

describe("Abnahme: kein Zauber bereit", function()
  it("liefert nil, wenn alle Zauber auf Cooldown sind", function()
    local spells = {
      { name = "Pyroblast", priority = 10, cooldown = 5 },
      { name = "Fireball", priority = 5, cooldown = 3 },
    }
    assert.is_nil(rotation.next_spell(spells))
  end)
end)
`;

const GREEN_SPEC = `describe("immer gruen", function()
  it("ok", function()
    assert.is_true(true)
  end)
end)
`;

const criteria = [
  { id: "AC-1", given: "ein Zauber auf Cooldown", when: "next_spell laeuft", then: "wird er uebersprungen", source: "task" },
  { id: "AC-2", given: "kein Zauber bereit", when: "next_spell laeuft", then: "ist das Ergebnis nil", source: "task" },
];

const slices = [
  { id: "S1", title: "Cooldown ueberspringen", criteria: ["AC-1"], files: ["src/rotation.lua"], depends_on: [] },
  { id: "S2", title: "Nil ohne bereiten Zauber", criteria: ["AC-2"], files: ["src/rotation.lua"], depends_on: ["S1"] },
];

function writeTest(cwd: string, path: string, content: string) {
  mkdirSync(join(cwd, "spec/acceptance"), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

const s1Ok: Handler = async (spec) => {
  writeTest(spec.cwd, S1_FILE, ACCEPTANCE_SPEC);
  return { output: { summary: "S1-Test", acceptance_tests: [S1_FILE], claims: [] } };
};
const s2Ok: Handler = async (spec) => {
  writeTest(spec.cwd, S2_FILE, S2_SPEC);
  return { output: { summary: "S2-Test", acceptance_tests: [S2_FILE], claims: [] } };
};
const s2Green: Handler = async (spec) => {
  writeTest(spec.cwd, S2_FILE, GREEN_SPEC);
  return { output: { summary: "S2-Test", acceptance_tests: [S2_FILE], claims: [] } };
};
/** S2 schwaecht den Test von S1 ab und schreibt dabei den eigenen. */
const s2Tamper: Handler = async (spec) => {
  writeTest(spec.cwd, S1_FILE, GREEN_SPEC);
  writeTest(spec.cwd, S2_FILE, S2_SPEC);
  return { output: { summary: "S2-Test", acceptance_tests: [S2_FILE], claims: [] } };
};

const implementerOk: Handler = async (spec) => {
  writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
  return { output: { summary: "umgesetzt", changed_files: ["src/rotation.lua"], claims: [] } };
};

function makePlugin(): string {
  const plugin = mkdtempSync(join(tmpdir(), "usac-plugin-"));
  for (const d of ["agents", "schemas", "gate-profiles", "routing.yaml"]) cpSync(join(REPO_ROOT, d), join(plugin, d), { recursive: true });
  mkdirSync(join(plugin, "workflows"));
  writeFileSync(
    join(plugin, "workflows/feature.yaml"),
    [
      "name: feature",
      "phases:",
      "  - name: setup",
      "  - name: spec",
      "  - name: approve_spec",
      "  - name: plan",
      "  - name: acceptance",
      "    role: test-engineer",
      "    variant: acceptance",
      "  - name: approve_h1",
      "    approval: h1",
      "  - name: lock",
      "  - name: implement",
      "    role: implementer",
      "escalation: default",
      "",
    ].join("\n"),
  );
  return plugin;
}

function setup(testEngineer: Handler[], auto: string[] = []) {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner({ "test-engineer": testEngineer, implementer: implementerOk });
  const orch = createOrchestrator({ store, runner, pluginRoot: makePlugin(), home, approvals: { auto }, graphify: false });
  const submit = () => orch.submit({ projectPath: project, type: "feature", title: "Cooldown-Rotation", description: "Cooldowns beachten" });
  const teCalls = () => runner.calls.filter((c) => c.role === "test-engineer");
  const events = (id: string) => store.events({ traceId: id });
  return { store, orch, submit, teCalls, events };
}

describe("Phase 1b: roter Test je Slice", () => {
  let snapshot: PhaseSnapshot;
  beforeEach(() => {
    snapshot = snapshotPhases();
    registerPhase("spec", async (wi, ctx) =>
      ctx.save(wi, { spec: { summary: "Cooldowns", title: "Cooldown-Rotation", criteria, out_of_scope: [], claims: [], questions: [] } }),
    );
    registerPhase("approve_spec", async (wi, ctx) => {
      ctx.emit(wi, "test.phase.approve_spec");
      return wi;
    });
    registerPhase("plan", async (wi, ctx) => ctx.save(wi, { slices, sliceOrder: ["S1", "S2"] }));
  });
  afterEach(() => restorePhases(snapshot));

  test("jeder Slice bekommt einen eigenen roten Test", async () => {
    const { orch, submit, teCalls, events } = setup([s1Ok, s2Ok]);
    const wi = await submit();
    const result = await orch.run(wi.id);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("awaiting_approval");

    const calls = teCalls();
    expect(calls.length).toBe(2);
    expect(calls[0]!.prompt).toContain("Slice S1");
    expect(calls[0]!.prompt).not.toContain("Slice S2");
    expect(calls[1]!.prompt).toContain("Slice S2");
    // Nur die Kriterien des Slices stehen im Prompt.
    expect(calls[0]!.prompt).toContain("AC-1");
    expect(calls[0]!.prompt).not.toContain("AC-2");

    const evs = events(wi.id);
    const reds = evs.filter((e) => e.type === "acceptance.red");
    expect(reds.map((e) => (e.data as { slice?: string }).slice)).toEqual(["S1", "S2"]);
    expect((reds[0]!.data as { files: string[] }).files).toEqual([S1_FILE]);
    expect((reds[1]!.data as { files: string[] }).files).toEqual([S2_FILE]);
    const h1 = evs.find((e) => e.type === "approval.requested" && (e.data as { kind: string }).kind === "h1")!;
    expect(h1).toBeDefined();
    for (const r of reds) expect(r.id).toBeLessThan(h1.id);
    // Freigabe H1 umfasst die Vereinigung aller Slice-Tests in sliceOrder-Reihenfolge.
    expect((h1.data as { files: string[] }).files).toEqual([S1_FILE, S2_FILE]);
  }, 60_000);

  test("ein grüner Slice-Test wird abgelehnt", async () => {
    const { store, orch, submit, teCalls, events } = setup([s1Ok, s2Green, s2Ok]);
    const wi = await submit();
    const result = await orch.run(wi.id);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("awaiting_approval");

    const calls = teCalls();
    expect(calls.length).toBe(3);
    expect(calls[2]!.prompt).toContain("Slice S2");
    const rejected = events(wi.id).filter((e) => e.type === "acceptance.rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0]!.data as { slice?: string }).slice).toBe("S2");
    // Das Verwerfen von S2 darf den Test von S1 nicht loeschen.
    const worktree = store.getWorkItem(wi.id)!.worktree!;
    expect(readFileSync(join(worktree, S1_FILE), "utf8")).toBe(ACCEPTANCE_SPEC);
    expect(readFileSync(join(worktree, S2_FILE), "utf8")).toBe(S2_SPEC);
  }, 60_000);

  test("S2 darf den Test von S1 nicht ändern", async () => {
    const { store, orch, submit, teCalls, events } = setup([s1Ok, s2Tamper, s2Ok]);
    const wi = await submit();
    const result = await orch.run(wi.id);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("awaiting_approval");

    expect(teCalls().length).toBe(3);
    const violations = events(wi.id).filter((e) => e.type === "anticheat.violation");
    expect(violations.length).toBe(1);
    expect((violations[0]!.data as { slice?: string }).slice).toBe("S2");
    const worktree = store.getWorkItem(wi.id)!.worktree!;
    expect(readFileSync(join(worktree, S1_FILE), "utf8")).toBe(ACCEPTANCE_SPEC);
    const reds = events(wi.id).filter((e) => e.type === "acceptance.red");
    expect(reds.map((e) => (e.data as { slice?: string }).slice)).toEqual(["S1", "S2"]);
  }, 60_000);

  test("Resume mitten in acceptance eskaliert, wenn ein früherer Slice-Test fehlt", async () => {
    const { store, orch, submit, teCalls } = setup([s1Ok, s2Ok]);
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    // Stand nach S1, vor S2 nachstellen; der unversionierte S1-Test ist inzwischen verschwunden.
    const cur = store.getWorkItem(wi.id)!;
    const s = cur.state as Record<string, unknown>;
    store.updateWorkItem(wi.id, {
      status: "running",
      state: { ...s, phase: "acceptance", sliceTests: { S1: [S1_FILE] }, acceptanceFiles: undefined, h1ApprovalId: undefined },
    });
    rmSync(join(cur.worktree!, S1_FILE));
    rmSync(join(cur.worktree!, S2_FILE));
    const before = teCalls().length;
    const result = await orch.run(wi.id);
    expect(result.status).toBe("escalated");
    expect(result.reason).toContain(S1_FILE);
    expect(teCalls().length).toBe(before);
  }, 60_000);

  test("grüner Nachweis je Slice", async () => {
    const { orch, submit, events } = setup([s1Ok, s2Ok], ["h1"]);
    const wi = await submit();
    const result = await orch.run(wi.id);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("done");

    const evs = events(wi.id);
    const greens = evs.filter((e) => e.type === "acceptance.green");
    expect(greens.map((e) => (e.data as { slice?: string }).slice)).toEqual(["S1", "S2"]);
    for (const g of greens) {
      const slice = (g.data as { slice: string }).slice;
      const red = evs.find((e) => e.type === "acceptance.red" && (e.data as { slice?: string }).slice === slice)!;
      expect(red).toBeDefined();
      expect(red.id).toBeLessThan(g.id);
      const d = g.data as { gate_result_id: number; model: string; attempt: number };
      expect(d.gate_result_id).toBeGreaterThan(0);
      expect(d.model).toBeTruthy();
      expect(d.attempt).toBe(1);
    }
  }, 60_000);
});
