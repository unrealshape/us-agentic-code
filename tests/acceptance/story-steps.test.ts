/**
 * Abnahme Story-Verlauf: Jeder Rollen-Aufruf eines Auftrags wird als Schritt in der Datenbank gespeichert
 * (Rolle, Modell, Ergebnis, Dateiliste, Start und Ende). Die Story-Ansicht liest nur diese Tabelle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { createFeatureHandlers } from "../../packages/daemon/src/feature-phases";
import { registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../../packages/daemon/src/phases";
import { createIntegratorHandlers, realGit, type CmdResult, type GitRunner } from "../../packages/daemon/src/integrator";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";

const FILE = "src/rotation.lua";
const ACC = "spec/acceptance/a_spec.lua";

const criteria = [{ id: "AC-1", given: "g", when: "w", then: "t", source: "task" }];

let snapshot: PhaseSnapshot;
beforeEach(() => {
  snapshot = snapshotPhases();
  registerPhase("spec", async (wi, ctx) =>
    ctx.save(wi, { spec: { summary: "s", title: wi.title, criteria, out_of_scope: [], claims: [], questions: [] } }),
  );
  registerPhase("approve_spec", async (wi) => wi);
  registerPhase("plan", createFeatureHandlers().plan);
  // Attrappen fuer die Schlussphasen: push ohne Remote, gh ohne Netz (der Lauf endet vor H2).
  const git: GitRunner = async (cwd, args) => (args[0] === "push" ? { exitCode: 0, output: "" } : realGit(cwd, args));
  const gh = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    if (args[0] === "pr" && args[1] === "view") return { exitCode: 1, output: "" };
    if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, output: "https://github.com/x/y/pull/1" };
    return { exitCode: 0, output: "" };
  };
  const h = createIntegratorHandlers({ git, gh });
  registerPhase("push", h.push);
  registerPhase("pr", h.pr);
  registerPhase("approve_h2", h.approve_h2);
  registerPhase("merge", h.merge);
});
afterEach(() => restorePhases(snapshot));

describe("Story-Verlauf (Abnahme)", () => {
  test("jeder Rollen-Aufruf wird als Schritt mit Modell, Ergebnis und Dateiliste gespeichert", async () => {
    const project = setupProject();
    const home = tempHome();
    const store = openStore(join(home, "usac.db"));

    const te: Handler = async (spec) => {
      mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
      writeFileSync(join(spec.cwd, ACC), ACCEPTANCE_SPEC);
      return { output: { summary: "Test geschrieben", acceptance_tests: [ACC], claims: [] } };
    };
    const impl: Handler = async (spec) => {
      writeFileSync(join(spec.cwd, FILE), FIXED_ROTATION);
      return { output: { summary: "umgesetzt", changed_files: [FILE], claims: [] } };
    };
    const rev: Handler = async () => ({ output: { verdict: "approve", summary: "ok", findings: [], claims: [] } });
    // Der echte Plan-Schritt laeuft; der Tech Lead liefert einen Slice.
    const techLead: Handler = async () => ({
      output: {
        summary: "ein Slice",
        size: "small",
        slices: [{ id: "S1", title: "Cooldown-Filter", criteria: ["AC-1"], files: [FILE], depends_on: [] }],
        claims: [],
        questions: [],
      },
    });
    const runner = new ScriptedRunner({ "test-engineer": te, implementer: impl, "code-reviewer": rev, "tech-lead": techLead });

    const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: ["h1"] }, graphify: false });
    const wi = await orch.submit({ projectPath: project, type: "feature", title: "Story Schritte", description: "x" });
    await orch.run(wi.id);

    const steps = store.listSteps(wi.id);
    const roles = steps.map((s) => s.role);
    expect(roles).toContain("test-engineer");
    expect(roles).toContain("implementer");

    const implStep = steps.find((s) => s.role === "implementer")!;
    expect(implStep.model).toBeTruthy();
    expect(implStep.ok).toBe(true);
    expect(implStep.files).toEqual([FILE]);
    expect(implStep.startedAt).toBeTruthy();
    expect(implStep.endedAt).toBeTruthy();

    // Slices: der Plan wird als Slices gespeichert, jeder Abnahmetest gehoert zu seinem Slice.
    const slices = store.listSlices(wi.id);
    expect(slices.map((s) => s.id)).toEqual(["S1"]);
    expect(slices[0]!.status).toBe("green");
    expect(slices[0]!.files).toEqual([FILE]);
    expect(steps.find((s) => s.role === "test-engineer")!.sliceId).toBe("S1");
  }, 120_000);
});
