import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalystOutput, Slice } from "@usac/shared";
import type { WorkItem } from "../src/store";
import { PRECISION_RULES, analystPrompt, taskBlock, techLeadPrompt, testEngineerPrompt } from "../src/prompts";
import { REPO_ROOT } from "../../../tests/helpers";

const wi: WorkItem = {
  id: "w1", projectPath: "/p", type: "feature", title: "Cooldowns", description: "Rotation beachtet Cooldowns",
  size: "standard", status: "created" as WorkItem["status"], branch: null, worktree: null, state: {}, createdAt: "t",
};
const spec: AnalystOutput = {
  summary: "s", title: "t", out_of_scope: [], claims: [], questions: [],
  criteria: [
    { id: "AC-1", given: "g1", when: "w1", then: "Ergebnis eins", source: "task" },
    { id: "AC-2", given: "g2", when: "w2", then: "Ergebnis zwei", source: "user" },
  ],
};
const slice: Slice = { id: "S2", title: "zweiter", criteria: ["AC-2"], files: ["src/a.lua"], depends_on: [] };

describe("Prompts Phase 1b", () => {
  test("Analyst-Prompt verlangt Kriterien statt Datei", () => {
    const p = analystPrompt(wi);
    expect(p).toContain(taskBlock(wi));
    expect(p).toContain("AC-1");
    expect(p).toContain(PRECISION_RULES);
    expect(p).toContain("Du schreibst keine Dateien");
  });
  test("Tech-Lead-Prompt listet alle Kriterien der Spec", () => {
    const p = techLeadPrompt(wi, spec, "mehr Slices");
    expect(p).toContain("AC-1");
    expect(p).toContain("AC-2");
    expect(p).toContain("Ergebnis eins");
    expect(p).toContain("Ergebnis zwei");
    expect(p).toContain("höchstens 8 Slices");
    expect(p).toContain("mehr Slices");
  });
  test("Test-Engineer-Prompt nennt den Slice", () => {
    const p = testEngineerPrompt(wi, undefined, { slice, criteria: spec.criteria.slice(1) });
    expect(p).toContain("S2");
    expect(p).toContain("Ergebnis zwei");
    expect(p).not.toContain("Ergebnis eins");
    expect(p).toContain("Nur Tests für diesen Slice");
    expect(testEngineerPrompt(wi, "fb")).toBe(testEngineerPrompt(wi, "fb", undefined));
    expect(testEngineerPrompt(wi)).not.toContain("Nur Tests für diesen Slice");
  });
  test("Rollentexte erwähnen die Ausgabe", () => {
    const a = readFileSync(join(REPO_ROOT, "agents", "analyst.md"), "utf8");
    const t = readFileSync(join(REPO_ROOT, "agents", "tech-lead.md"), "utf8");
    expect(a).toContain("spec/feature.md wird vom Orchestrator geschrieben");
    expect(t).toContain("höchstens 8 Slices");
  });
});
