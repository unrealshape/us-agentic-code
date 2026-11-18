import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnalystOutput, TechLeadOutput } from "@usac/shared";
import { REPO_ROOT } from "../../../tests/helpers";

const ac = { id: "AC-1", given: "g", when: "w", then: "t", source: "task" };
const slice = (n: number) => ({ id: `S${n}`, title: "x", criteria: ["AC-1"], files: ["src/a.lua"] });

describe("Rollen-Ausgaben Analyst und Tech Lead", () => {
  test("Analyst-Ausgabe verlangt mindestens ein Kriterium mit AC-Nummer", () => {
    expect(AnalystOutput.safeParse({ summary: "s", title: "t", criteria: [], claims: [] }).success).toBe(false);
    expect(AnalystOutput.safeParse({ summary: "s", title: "t", criteria: [ac], claims: [] }).success).toBe(true);
    expect(AnalystOutput.safeParse({ summary: "s", title: "t", criteria: [{ ...ac, id: "A1" }], claims: [] }).success).toBe(false);
  });

  test("Tech-Lead-Ausgabe begrenzt auf 8 Slices", () => {
    const nine = Array.from({ length: 9 }, (_, i) => slice(i + 1));
    expect(TechLeadOutput.safeParse({ summary: "s", size: "small", slices: nine, claims: [] }).success).toBe(false);
    const ok = TechLeadOutput.safeParse({ summary: "s", size: "small", slices: [slice(1)], claims: [] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.slices[0]!.depends_on).toEqual([]);
  });

  test("JSON-Schemas für analyst und tech-lead existieren", () => {
    const load = (n: string) => JSON.parse(readFileSync(join(REPO_ROOT, "schemas", `${n}.schema.json`), "utf8"));
    const a = load("analyst");
    const t = load("tech-lead");
    for (const s of [a, t]) {
      expect(s.type).toBe("object");
      expect(s.required).toContain("claims");
    }
    expect(a.required).toContain("criteria");
    expect(t.required).toContain("slices");
    expect(t.required).toContain("size");
  });
});
