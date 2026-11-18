import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCriterion, Slice } from "@usac/shared";
import { criteriaEvidence } from "../src/criteria-evidence";
import type { GateResult } from "../src/store";

function ac(id: string): AcceptanceCriterion {
  return { id, given: "g", when: "w", then: "t", source: "task" };
}

function slice(id: string, criteria: string[]): Slice {
  return { id, title: id, criteria, files: ["src/x.lua"], depends_on: [] };
}

function gate(id: number, status: GateResult["status"]): GateResult {
  return { id, workItemId: "WI-1", name: "acceptance", status, exitCode: status === "passed" ? 0 : 1, durationMs: 1, output: "" };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "usac-crit-"));
  mkdirSync(join(cwd, "spec"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(rel: string, text: string) {
  writeFileSync(join(cwd, rel), text);
}

describe("criteriaEvidence", () => {
  test("alle Kriterien belegt", () => {
    write("spec/s1_spec.lua", 'it("[AC-1] Rotation", function() end)\n');
    write("spec/s2_spec.lua", 'it("[AC-2] Cooldown", function() end)\n');
    const res = criteriaEvidence({
      cwd,
      criteria: [ac("AC-1"), ac("AC-2")],
      slices: [slice("S1", ["AC-1"]), slice("S2", ["AC-2"])],
      sliceTests: { S1: ["spec/s1_spec.lua"], S2: ["spec/s2_spec.lua"] },
      sliceGates: { S1: gate(11, "passed"), S2: gate(12, "passed") },
    });
    expect(res).toEqual([
      { criterion: "AC-1", status: "proven", tests: ["spec/s1_spec.lua"], gate_result_id: 11 },
      { criterion: "AC-2", status: "proven", tests: ["spec/s2_spec.lua"], gate_result_id: 12 },
    ]);
  });

  test("Marke fehlt", () => {
    write("spec/s1_spec.lua", 'it("[AC-1] Rotation", function() end)\n');
    write("spec/s2_spec.lua", 'it("Cooldown ohne Marke", function() end)\n');
    const res = criteriaEvidence({
      cwd,
      criteria: [ac("AC-1"), ac("AC-2")],
      slices: [slice("S1", ["AC-1"]), slice("S2", ["AC-2"])],
      sliceTests: { S1: ["spec/s1_spec.lua"], S2: ["spec/s2_spec.lua"] },
      sliceGates: { S1: gate(11, "passed"), S2: gate(12, "passed") },
    });
    expect(res[0]!.status).toBe("proven");
    expect(res[1]!.status).toBe("missing");
    expect(res[1]!.reason).toContain("Marke [AC-2]");
    expect(res[1]!.gate_result_id).toBeUndefined();
  });

  test("Gate rot", () => {
    write("spec/s1_spec.lua", 'it("[AC-1] Rotation", function() end)\n');
    const res = criteriaEvidence({
      cwd,
      criteria: [ac("AC-1")],
      slices: [slice("S1", ["AC-1"])],
      sliceTests: { S1: ["spec/s1_spec.lua"] },
      sliceGates: { S1: gate(11, "failed") },
    });
    expect(res).toHaveLength(1);
    expect(res[0]!.status).toBe("missing");
    expect(res[0]!.reason).toContain("Gate");
  });

  test("AC-1 vs AC-10", () => {
    write("spec/s1_spec.lua", 'it("[AC-10] anderes Kriterium", function() end)\n');
    const res = criteriaEvidence({
      cwd,
      criteria: [ac("AC-1"), ac("AC-10")],
      slices: [slice("S1", ["AC-1", "AC-10"])],
      sliceTests: { S1: ["spec/s1_spec.lua"] },
      sliceGates: { S1: gate(11, "passed") },
    });
    expect(res.find((r) => r.criterion === "AC-1")!.status).toBe("missing");
    expect(res.find((r) => r.criterion === "AC-10")!.status).toBe("proven");
  });

  test("ohne Slices (bugfix)", () => {
    expect(criteriaEvidence({ cwd, criteria: [], slices: [], sliceTests: {}, sliceGates: {} })).toEqual([]);
  });

  test("kein Slice deckt das Kriterium ab", () => {
    const res = criteriaEvidence({ cwd, criteria: [ac("AC-3")], slices: [], sliceTests: {}, sliceGates: {} });
    expect(res[0]!.status).toBe("missing");
    expect(res[0]!.reason).toContain("Slice");
  });
});
