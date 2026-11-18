/**
 * Abnahme Phase 1b, Task 6: feature laeuft mit den echten Handlern bis zur Freigabe H1 (schliesst I1).
 *
 * Keine Test-Handler: alle Phasen kommen aus orchestrator.ts und registry-setup.ts.
 * Nur die Rollen sind per ScriptedRunner nachgebaut.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ACCEPTANCE_SPEC, git, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import "../../packages/daemon/src/registry-setup";
import { missingPhases } from "../../packages/daemon/src/phases";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";
import { loadWorkflow } from "../../packages/daemon/src/workflow";

const criteria = [
  { id: "AC-1", given: "ein Zauber auf Cooldown", when: "next_spell laeuft", then: "wird er uebersprungen", source: "task" },
  { id: "AC-2", given: "kein Zauber bereit", when: "next_spell laeuft", then: "ist das Ergebnis nil", source: "task" },
];

const analyst: Handler = async () => ({
  output: { summary: "Cooldowns beachten", title: "Cooldown-Rotation", criteria, out_of_scope: [], claims: [], questions: [] },
});

const techLead: Handler = async () => ({
  output: {
    summary: "Zwei Slices",
    size: "small",
    slices: [
      { id: "S1", title: "Cooldown ueberspringen", criteria: ["AC-1"], files: ["src/rotation.lua"], depends_on: [] },
      { id: "S2", title: "Nil ohne bereiten Zauber", criteria: ["AC-2"], files: ["src/rotation.lua"], depends_on: ["S1"] },
    ],
    claims: [],
    questions: [],
  },
});

/** Je Aufruf eine eigene Datei unter spec/acceptance/, rot mit dem Ausgangscode. */
function testEngineer(): Handler {
  let n = 0;
  return async (spec) => {
    n++;
    const file = `spec/acceptance/slice${n}_spec.lua`;
    mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
    writeFileSync(join(spec.cwd, file), ACCEPTANCE_SPEC);
    return { output: { summary: `Slice-Test ${n}`, acceptance_tests: [file], claims: [] } };
  };
}

function setup(auto: string[]) {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner({ analyst, "tech-lead": techLead, "test-engineer": testEngineer() });
  const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto }, graphify: false });
  const submit = () => orch.submit({ projectPath: project, type: "feature", title: "Cooldown-Rotation", description: "Cooldowns beachten" });
  const pending = (id: string) => store.pendingApprovals().filter((a) => a.workItemId === id);
  return { project, store, runner, orch, submit, pending };
}

describe("Phase 1b: feature bis H1 mit echten Handlern", () => {
  test("für feature fehlt kein Phasen-Handler", () => {
    expect(missingPhases(loadWorkflow(join(REPO_ROOT, "workflows/feature.yaml")))).toEqual([]);
  });

  test("feature läuft mit echten Handlern bis zur Freigabe H1", async () => {
    const { project, store, orch, submit, pending } = setup(["spec"]);
    const wi = await submit();
    const result = await orch.run(wi.id);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("awaiting_approval");
    expect(pending(wi.id).map((a) => a.kind)).toEqual(["h1"]);

    const evs = store.events({ traceId: wi.id });
    const at = (type: string, pred: (d: Record<string, unknown>) => boolean = () => true) =>
      evs.findIndex((e) => e.type === type && pred((e.data ?? {}) as Record<string, unknown>));
    const written = at("spec.written");
    const granted = at("approval.granted", (d) => d.kind === "spec");
    const planned = at("plan.created");
    const reds = evs.flatMap((e, i) => (e.type === "acceptance.red" ? [i] : []));
    const h1 = at("approval.requested", (d) => d.kind === "h1");
    expect(written).toBeGreaterThanOrEqual(0);
    expect(granted).toBeGreaterThan(written);
    expect(planned).toBeGreaterThan(granted);
    expect(reds).toHaveLength(2);
    expect(reds[0]!).toBeGreaterThan(planned);
    expect(h1).toBeGreaterThan(reds[1]!);

    const tree = git(project, "ls-tree", "-r", "--name-only", `usac/${wi.id}`).split("\n");
    expect(tree).toContain("spec/feature.md");
  }, 60_000);

  test("Resume startet Analyst und Tech Lead nicht neu", async () => {
    const { runner, orch, submit, pending } = setup([]);
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    expect(pending(wi.id).map((a) => a.kind)).toEqual(["spec"]);
    orch.approve(pending(wi.id)[0]!.id, true);

    const second = await orch.run(wi.id);
    expect(second.reason).toBeUndefined();
    expect(second.status).toBe("awaiting_approval");
    expect(pending(wi.id).map((a) => a.kind)).toEqual(["h1"]);
    expect(runner.calls.filter((c) => c.role === "analyst")).toHaveLength(1);
    expect(runner.calls.filter((c) => c.role === "tech-lead")).toHaveLength(1);
  }, 60_000);

  test("CLI lehnt unbekannte Auto-Freigabe ab", async () => {
    const project = setupProject();
    const proc = Bun.spawn(
      ["bun", join(REPO_ROOT, "packages/daemon/src/cli.ts"), "run", "feature", "-t", "x", "--auto", "foo", "--project", project],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, USAC_HOME: tempHome(), USAC_SANDBOX: "0" } },
    );
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(out + err).toContain("--auto erlaubt nur h1, spec");
    expect(out + err).not.toContain("angelegt");
  }, 60_000);
});
