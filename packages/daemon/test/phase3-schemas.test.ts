import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Evidence, ExplorerOutput, LearnerOutput, ROLE_OUTPUTS } from "@usac/shared";
import { REPO_ROOT } from "../../../tests/helpers";

const fileEv = { type: "file", path: "src/a.lua", lines: [1, 2], quote: "x" };

describe("Schemas Phase 3", () => {
  test("Graph-Beleg wird von Evidence akzeptiert", () => {
    expect(Evidence.safeParse({ type: "graph", node_id: "n1", path: "src/a.lua", lines: [1, 2], quote: "x" }).success).toBe(true);
    expect(Evidence.safeParse({ type: "graph", path: "src/a.lua", lines: [1, 2], quote: "x" }).success).toBe(false);
  });

  test("Learner verlangt Ereignis-Belege für Instincts", () => {
    const base = { summary: "s", memory: [], claims: [] };
    const instinct = { text: "erst Tests lesen", role: "implementer" };
    expect(LearnerOutput.safeParse({ ...base, instincts: [{ ...instinct, event_ids: [] }] }).success).toBe(false);
    expect(LearnerOutput.safeParse({ ...base, instincts: [{ ...instinct, event_ids: [3] }] }).success).toBe(true);
    const four = Array.from({ length: 4 }, () => ({ ...instinct, event_ids: [1] }));
    expect(LearnerOutput.safeParse({ ...base, instincts: four }).success).toBe(false);
    expect(
      LearnerOutput.safeParse({ ...base, instincts: [], memory: [{ kind: "fact", text: "t", evidence: [] }] }).success,
    ).toBe(false);
    expect(
      LearnerOutput.safeParse({ ...base, instincts: [], memory: [{ kind: "fact", text: "t", evidence: [fileEv] }] }).success,
    ).toBe(true);
    expect(ROLE_OUTPUTS.learner).toBe(LearnerOutput);
  });

  test("Explorer-Konventionen sind Aussagen mit Stufe", () => {
    const base = { summary: "s", languages: ["lua"], commands: { test: "busted" }, claims: [], questions: [] };
    expect(ExplorerOutput.safeParse({ ...base, conventions: [{ text: "Tabs", evidence: [fileEv] }] }).success).toBe(false);
    expect(
      ExplorerOutput.safeParse({ ...base, conventions: [{ text: "Tabs", level: "EXTRACTED", evidence: [fileEv] }] }).success,
    ).toBe(true);
    const eleven = Array.from({ length: 11 }, () => ({ text: "k", level: "INFERRED" }));
    expect(ExplorerOutput.safeParse({ ...base, conventions: eleven }).success).toBe(false);
    expect(ROLE_OUTPUTS.explorer).toBe(ExplorerOutput);
  });

  test("Schemas enthalten graph und memory", () => {
    const impl = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "implementer.schema.json"), "utf8"));
    const variants = impl.properties.claims.items.properties.evidence.items.oneOf as { properties: { type: { const: string } } }[];
    const consts = variants.map((v) => v.properties.type.const);
    expect(consts).toContain("graph");
    expect(consts).toContain("memory");
    expect(existsSync(join(REPO_ROOT, "schemas", "explorer.schema.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "schemas", "learner.schema.json"))).toBe(true);
  });
});
