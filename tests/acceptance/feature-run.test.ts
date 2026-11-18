/**
 * Abnahme Slice 3: Der Orchestrator fuehrt Workflow-Dateien aus.
 *
 * Phasen ohne eingebauten Handler (spec, approve_spec, plan, push, pr, approve_h2)
 * werden hier per registerPhase durch Test-Handler ersetzt; die echten Handler
 * fuer push/pr/approve_h2/merge kommen mit dem Integrator (Task 5).
 */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase } from "../../packages/daemon/src/phases";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore, type Store } from "../../packages/daemon/src/store";

const ACC_PATH = "spec/acceptance/cooldown_spec.lua";

const testEngineerOk: Handler = async (spec) => {
  mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
  writeFileSync(join(spec.cwd, ACC_PATH), ACCEPTANCE_SPEC);
  return { output: { summary: "Slice-Test geschrieben", acceptance_tests: [ACC_PATH], claims: [] } };
};

const implementerOk: Handler = async (spec) => {
  writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
  return { output: { summary: "Slice umgesetzt", changed_files: ["src/rotation.lua"], claims: [] } };
};

const reviewerOk: Handler = async () => ({
  output: { verdict: "approve", summary: "ok", findings: [], claims: [] },
});

/** Test-Handler fuer Phasen, deren echte Handler erst spaeter kommen. */
function registerScriptedPhases(store: () => Store) {
  for (const name of ["spec", "approve_spec", "plan", "push", "pr"]) {
    registerPhase(name, async (wi, ctx) => {
      ctx.emit(wi, `test.phase.${name}`);
      return wi;
    });
  }
  registerPhase("approve_h2", async (wi, ctx) => {
    const st = ctx.state(wi) as { h2ApprovalId?: number };
    let approval = st.h2ApprovalId ? store().getApproval(st.h2ApprovalId) : null;
    if (!approval) {
      approval = store().createApproval(wi.id, "h2", { title: wi.title });
      wi = ctx.save(wi, { h2ApprovalId: approval.id });
    }
    if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
    return wi;
  });
  // Ohne erteilte H2 darf merge nie laufen.
  registerPhase("merge", async () => {
    throw new Error("merge darf vor Freigabe H2 nicht laufen");
  });
}

function setup() {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  registerScriptedPhases(() => store);
  const runner = new ScriptedRunner({ "test-engineer": testEngineerOk, implementer: implementerOk, "code-reviewer": reviewerOk });
  const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: ["h1"] }, graphify: false });
  return { project, store, orch };
}

describe("Slice 3: Orchestrator als Interpreter", () => {
  test("feature läuft bis zur Freigabe H2 mit scripted Runner", async () => {
    const { project, store, orch } = setup();
    const wi = await orch.submit({ projectPath: project, type: "feature", title: "Cooldown beachten", description: "x" });
    const result = await orch.run(wi.id);

    expect(result.status).toBe("awaiting_approval");
    const pending = store.pendingApprovals().filter((a) => a.workItemId === wi.id);
    expect(pending.map((a) => a.kind)).toEqual(["h2"]);

    // Phasen laufen in der Reihenfolge der Workflow-Datei.
    const types = store.events({ traceId: wi.id }).map((e) => e.type);
    const order = ["test.phase.spec", "test.phase.approve_spec", "test.phase.plan", "acceptance.red", "test.locked", "acceptance.green", "review.approved", "test.phase.push", "test.phase.pr"];
    const idx = order.map((t) => types.indexOf(t));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // Kein integrate im feature-Workflow.
    expect(types).not.toContain("integrated");
  }, 60_000);

  test("jeder Slice bekommt eigenen roten Test vor der Implementierung", async () => {
    const { project, store, orch } = setup();
    const wi = await orch.submit({ projectPath: project, type: "feature", title: "Cooldown beachten", description: "x" });
    await orch.run(wi.id);

    const types = store.events({ traceId: wi.id }).map((e) => e.type);
    const reds = types.flatMap((t, i) => (t === "acceptance.red" ? [i] : []));
    const greens = types.flatMap((t, i) => (t === "acceptance.green" ? [i] : []));
    expect(greens.length).toBeGreaterThan(0);
    expect(reds.length).toBe(greens.length);
    greens.forEach((g, n) => expect(reds[n]!).toBeLessThan(g));
  }, 60_000);

  test("unbekannte Phase im Workflow bricht mit klarer Meldung ab", async () => {
    const plugin = mkdtempSync(join(tmpdir(), "usac-plugin-"));
    for (const d of ["agents", "schemas", "gate-profiles", "routing.yaml"]) cpSync(join(REPO_ROOT, d), join(plugin, d), { recursive: true });
    mkdirSync(join(plugin, "workflows"));
    writeFileSync(join(plugin, "workflows/bugfix.yaml"), "name: bugfix\nphases:\n  - name: setup\n  - name: zaubern\n");
    const project = setupProject();
    const home = tempHome();
    const store = openStore(join(home, "usac.db"));
    const orch = createOrchestrator({ store, runner: new ScriptedRunner({}), pluginRoot: plugin, home, graphify: false });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "x", description: "x" });
    const result = await orch.run(wi.id);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain('"zaubern"');
    // Abbruch vor der ersten Phase, nichts wird still uebersprungen.
    expect(store.events({ traceId: wi.id }).map((e) => e.type)).not.toContain("worktree.created");
  }, 60_000);
});
