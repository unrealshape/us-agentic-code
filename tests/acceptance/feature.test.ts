import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadWorkflow, type PhaseSpec } from "../../packages/daemon/src/workflow";

const wf = loadWorkflow(join(import.meta.dir, "../../workflows/feature.yaml"));

describe("Workflow feature", () => {
  test("feature hat Spec, Slice-Planung, rote Slice-Tests, Freigaben und Integrator in dieser Reihenfolge", () => {
    expect(wf.phases.map((p) => p.name)).toEqual([
      "setup", "spec", "approve_spec", "plan", "acceptance", "approve_h1",
      "lock", "implement", "review", "integrate", "push", "pr", "approve_h2", "merge",
    ]);
  });

  test("jeder Slice-Test muss vor der Implementierung rot sein", () => {
    const acc = wf.phases.find((p) => p.name === "acceptance")!;
    expect(acc.role).toBe("test-engineer");
    expect(acc.variant).toBe("acceptance");
    expect(acc.expect).toBe("gate_fails");
  });

  test("Rollen, Gates und Freigaben", () => {
    const by = (n: string): PhaseSpec => wf.phases.find((p) => p.name === n)!;
    expect(by("spec").role).toBe("analyst");
    expect(by("plan").role).toBe("tech-lead");
    expect(by("implement").role).toBe("implementer");
    expect(by("implement").until).toEqual(["format", "lint", "unit", "acceptance"]);
    expect(by("implement").max_attempts).toBe(6);
    expect(by("review").role).toBe("code-reviewer");
    expect(by("review").block_on).toEqual(["critical", "high"]);
    expect(by("approve_h2").approval).toBe("h2");
    for (const n of ["push", "pr", "merge"]) expect(by(n).role).toBeUndefined();
  });
});
