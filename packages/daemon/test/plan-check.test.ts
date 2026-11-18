import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Slice, TechLeadOutput } from "@usac/shared";
import { loadGateProfile } from "../src/config";
import { checkPlan, sliceOrder } from "../src/plan-check";
import { REPO_ROOT } from "../../../tests/helpers";

const gp = loadGateProfile(REPO_ROOT, "lua");
const sl = (id: string, criteria: string[], depends_on: string[] = [], files = ["src/a.lua"]): Slice => ({
  id, title: "x", criteria, files, depends_on,
});
const plan = (slices: Slice[]): TechLeadOutput => ({ summary: "s", size: "standard", slices, claims: [], questions: [] });
const AC = ["AC-1", "AC-2", "AC-3"];

describe("checkPlan", () => {
  test("nicht abgedecktes Kriterium", () => {
    const r = checkPlan(AC, plan([sl("S1", ["AC-1"]), sl("S2", ["AC-2"])]), gp);
    expect(r.errors).toContain("AC-3 ist keinem Slice zugeordnet");
  });
  test("unbekanntes Kriterium", () => {
    const r = checkPlan(AC, plan([sl("S1", ["AC-1", "AC-3"]), sl("S2", ["AC-2", "AC-9"])]), gp);
    expect(r.errors).toContain("S2 verweist auf unbekanntes Kriterium AC-9");
  });
  test("unbekannte Abhaengigkeit", () => {
    const r = checkPlan(AC, plan([sl("S1", ["AC-1", "AC-3"]), sl("S2", ["AC-2"], ["S7"])]), gp);
    expect(r.errors).toContain("S2 hängt von unbekanntem Slice S7 ab");
  });
  test("Zyklus", () => {
    const r = checkPlan(AC, plan([sl("S1", ["AC-1", "AC-3"], ["S2"]), sl("S2", ["AC-2"], ["S1"])]), gp);
    expect(r.errors).toContain("Zyklus: S1 -> S2 -> S1");
  });
  test("doppelte ID", () => {
    const r = checkPlan(AC, plan([sl("S1", ["AC-1", "AC-3"]), sl("S1", ["AC-2"])]), gp);
    expect(r.errors).toContain("Doppelte Slice-ID S1");
  });
  test("geschuetzte Datei", () => {
    const r = checkPlan(AC, plan([sl("S1", AC, [], [".usac/project.yaml"])]), gp);
    expect(r.errors).toContain("S1: geschützte Datei .usac/project.yaml");
  });
  test("Pfad ausserhalb und absolut", () => {
    for (const [f, msg] of [
      ["../x.lua", "S1: Pfad außerhalb des Projekts ../x.lua"],
      ["/etc/passwd", "S1: absoluter Pfad /etc/passwd"],
      ["C:/x.lua", "S1: absoluter Pfad C:/x.lua"],
    ]) {
      expect(checkPlan(AC, plan([sl("S1", AC, [], [f as string])]), gp).errors).toContain(msg as string);
    }
  });
  test("Backslash-Pfade werden normalisiert", () => {
    const r = checkPlan(AC, plan([sl("S1", AC, [], ["src\\rotation.lua"])]), gp);
    expect(r.errors).toEqual([]);
    expect(r.plan.slices[0]?.files).toEqual(["src/rotation.lua"]);
  });
});

describe("sliceOrder", () => {
  test("topologisch, stabil", () => {
    expect(sliceOrder([sl("S2", ["AC-1"], ["S1"]), sl("S1", ["AC-1"]), sl("S3", ["AC-1"])])).toEqual(["S1", "S2", "S3"]);
  });
});
