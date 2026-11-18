import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { activePhases, loadWorkflow, Workflow } from "../../packages/daemon/src/workflow";

const load = (name: string): Workflow => loadWorkflow(join(import.meta.dir, "../../workflows", `${name}.yaml`));
const names = (wf: Workflow) => wf.phases.map((p) => p.name);
const by = (wf: Workflow, n: string) => wf.phases.find((p) => p.name === n)!;
const preview = { command: "bun run dev --port {port}", health_path: "/", ready_timeout_ms: 60_000 };

const SEQUENCES: Record<string, string[]> = {
  feature: [
    "setup", "spec", "approve_spec", "design", "plan", "acceptance", "approve_h1", "lock", "implement",
    "qa", "verify", "review", "integrate", "push", "pr", "approve_h2", "merge",
  ],
  "new-project": [
    "setup", "spec", "approve_spec", "design", "environment", "plan", "acceptance", "approve_h1", "lock",
    "implement", "qa", "verify", "review", "integrate", "push", "pr", "approve_h2", "merge",
  ],
  change: [
    "setup", "spec", "approve_spec", "acceptance", "approve_h1", "lock", "implement", "qa", "verify",
    "review", "integrate", "push", "pr", "approve_h2", "merge",
  ],
  refactor: [
    "setup", "characterize", "approve_h1", "lock", "implement", "verify", "review", "integrate",
    "push", "pr", "approve_h2", "merge",
  ],
  "dependency-update": [
    "setup", "environment", "verify", "security", "review", "integrate", "push", "pr", "approve_h2", "merge",
  ],
  "security-fix": [
    "setup", "acceptance", "approve_h1", "lock", "implement", "verify", "security", "review", "integrate",
    "push", "pr", "approve_h2", "merge",
  ],
  spike: ["setup", "research", "approve_report", "integrate", "push", "pr", "approve_h2", "merge"],
};

describe("Workflow-Dateien (Phase 4)", () => {
  for (const [name, seq] of Object.entries(SEQUENCES)) {
    test(`${name}: Phasenfolge ist exakt`, () => {
      const wf = load(name);
      expect(wf.name).toBe(name);
      expect(names(wf)).toEqual(seq);
    });
  }

  test("design nur bei large", () => {
    const wf = load("feature");
    expect(by(wf, "design").when?.size).toEqual(["large"]);
    expect(activePhases(wf, { size: "small" }, {}).map((p) => p.name)).not.toContain("design");
    expect(activePhases(wf, { size: "standard" }, {}).map((p) => p.name)).not.toContain("design");
    expect(activePhases(wf, { size: "large" }, {}).map((p) => p.name)).toContain("design");
  });

  test("qa nur mit Preview", () => {
    for (const name of ["feature", "new-project", "change"]) {
      const wf = load(name);
      expect(by(wf, "qa").when?.preview).toBe(true);
      expect(activePhases(wf, { size: "standard" }, {}).map((p) => p.name)).not.toContain("qa");
      expect(activePhases(wf, { size: "standard" }, { preview }).map((p) => p.name)).toContain("qa");
    }
  });

  test("Phasen ohne Bedingung bleiben in Reihenfolge erhalten", () => {
    const wf = load("feature");
    expect(activePhases(wf, { size: "small" }, {}).map((p) => p.name)).toEqual(
      SEQUENCES.feature!.filter((n) => n !== "design" && n !== "qa"),
    );
    expect(activePhases(wf, { size: "large" }, { preview }).map((p) => p.name)).toEqual(SEQUENCES.feature!);
  });

  test("new-project entwirft immer, unabhaengig von der Groesse", () => {
    const wf = load("new-project");
    expect(by(wf, "design").when).toBeUndefined();
    expect(activePhases(wf, { size: "small" }, {}).map((p) => p.name)).toContain("design");
  });

  test("refactor verlangt gruene Charakterisierung", () => {
    expect(by(load("refactor"), "characterize").expect).toBe("gate_passes");
  });

  test("approve_report hat approval: report", () => {
    expect(by(load("spike"), "approve_report").approval).toBe("report");
  });

  test("Workflow lehnt unbekannte Groesse in when ab", () => {
    const wf = { name: "x", phases: [{ name: "a", when: { size: ["riesig"] } }] };
    expect(() => Workflow.parse(wf)).toThrow();
  });
});
