import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArchitectOutput,
  EnvironmentOutput,
  QaOutput,
  ROLE_OUTPUTS,
  type WorkItemType,
} from "@usac/shared";
import { REPO_ROOT } from "../../../tests/helpers";

const option = (name: string) => ({ name, pros: ["schnell"], cons: ["neu"] });

describe("Schemas Phase 4", () => {
  test("Architect braucht mindestens zwei Optionen", () => {
    const base = { summary: "s", decision: "A", risks: [], claims: [], questions: [] };
    expect(ArchitectOutput.safeParse({ ...base, options: [option("A")] }).success).toBe(false);
    expect(ArchitectOutput.safeParse({ ...base, options: [option("A"), option("B")] }).success).toBe(true);
    const adr = { title: "t", context: "k", decision: "d", consequences: "f" };
    expect(ArchitectOutput.safeParse({ ...base, options: [option("A"), option("B")], adr }).success).toBe(true);
    expect(
      ArchitectOutput.safeParse({ ...base, options: [option("A"), option("B")], adr: { title: "t" } }).success,
    ).toBe(false);
    expect(ROLE_OUTPUTS.architect).toBe(ArchitectOutput);
  });

  test("QA nennt E2E-Tests", () => {
    expect(QaOutput.safeParse({ summary: "s", e2e_tests: [], criteria: ["AC-1"], claims: [] }).success).toBe(false);
    expect(
      QaOutput.safeParse({ summary: "s", e2e_tests: ["e2e/login.spec.ts"], criteria: ["AC-1"], claims: [] }).success,
    ).toBe(true);
    expect(
      QaOutput.safeParse({ summary: "s", e2e_tests: ["e2e/login.spec.ts"], criteria: ["A1"], claims: [] }).success,
    ).toBe(false);
    expect(ROLE_OUTPUTS["qa-engineer"]).toBe(QaOutput);
  });

  test("Environment Engineer nennt Dateien und Befehle", () => {
    const ok = EnvironmentOutput.safeParse({ summary: "s", claims: [] });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.changed_files).toEqual([]);
      expect(ok.data.setup_commands).toEqual([]);
      expect(ok.data.questions).toEqual([]);
    }
    expect(ROLE_OUTPUTS["environment-engineer"]).toBe(EnvironmentOutput);
  });

  test("Schemas existieren", () => {
    for (const role of ["architect", "qa-engineer", "environment-engineer"]) {
      const file = join(REPO_ROOT, "schemas", `${role}.schema.json`);
      expect(existsSync(file)).toBe(true);
      const schema = JSON.parse(readFileSync(file, "utf8"));
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(expect.arrayContaining(["summary", "claims"]));
    }
    const arch = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "architect.schema.json"), "utf8"));
    expect(arch.properties.options.minItems).toBe(2);
    const qa = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "qa-engineer.schema.json"), "utf8"));
    expect(qa.properties.e2e_tests.minItems).toBe(1);
  });

  test("alle Auftragstypen sind bekannt", () => {
    const types = [
      "bugfix",
      "feature",
      "change",
      "refactor",
      "new-project",
      "dependency-update",
      "security-fix",
      "spike",
      "onboarding",
    ] as const satisfies readonly WorkItemType[];
    expect(types).toHaveLength(9);
  });
});
