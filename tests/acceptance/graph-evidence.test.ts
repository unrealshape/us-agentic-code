import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../packages/shared/src/index";
import { checkEvidence, type EvidenceContext } from "../../packages/daemon/src/evidence";
import { findNodes, loadGraph } from "../../packages/daemon/src/graph";
import { openStore } from "../../packages/daemon/src/store";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** Kopie des Lua-Fixtures; mit `withGraph` liegt das echte graph.json aus tests/fixtures/graph darin. */
function project(withGraph: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "usac-graph-"));
  cpSync(join(FIXTURES, "lua-rotation"), dir, { recursive: true });
  if (withGraph) {
    mkdirSync(join(dir, "graphify-out"));
    copyFileSync(join(FIXTURES, "graph", "graph.json"), join(dir, "graphify-out", "graph.json"));
  }
  return dir;
}

function ctx(cwd: string, extra: Partial<EvidenceContext> = {}): EvidenceContext {
  const home = mkdtempSync(join(tmpdir(), "usac-graph-home-"));
  return { cwd, store: openStore(join(home, "usac.db")), workItemId: "w1", ...extra };
}

const graphEvidence = (over: Partial<Extract<Evidence, { type: "graph" }>> = {}): Evidence => ({
  type: "graph",
  node_id: "src_rotation_m_next_spell",
  path: "src/rotation.lua",
  lines: [6, 6],
  quote: "function M.next_spell(spells)",
  ...over,
});

describe("Graph- und Memory-Belege (Phase 3)", () => {
  test("ein Beleg aus dem Graph ist pruefbar", () => {
    const cwd = project(true);
    const nodes = loadGraph(cwd);
    expect(nodes).not.toBeNull();
    const hit = findNodes(nodes!, ["next_spell"]);
    expect(hit.map((n) => n.id)).toContain("src_rotation_m_next_spell");
    expect(hit[0]).toMatchObject({ path: "src/rotation.lua", line: 6 });
    expect(checkEvidence(graphEvidence(), ctx(cwd))).toBeNull();
  });

  test("falscher Knoten oder geaenderte Datei macht den Beleg ungueltig", () => {
    const cwd = project(true);
    expect(checkEvidence(graphEvidence({ node_id: "gibt_es_nicht" }), ctx(cwd))).toContain("Knoten");
    expect(checkEvidence(graphEvidence({ path: "spec/rotation_spec.lua" }), ctx(cwd))).toContain("Knoten");
    writeFileSync(join(cwd, "src", "rotation.lua"), "local M = {}\nreturn M\n\n\n\nfunction M.other(x)\n");
    expect(checkEvidence(graphEvidence(), ctx(cwd))).toContain("Zitat steht nicht");
  });

  test("ohne graph.json ist ein Graph-Beleg ungueltig", () => {
    const cwd = project(false);
    expect(loadGraph(cwd)).toBeNull();
    expect(checkEvidence(graphEvidence(), ctx(cwd))).toContain("kein Graph");
  });

  test("veralteter Memory-Beleg", () => {
    const cwd = project(false);
    const memEv: Evidence = { type: "memory", id: "m-1" };
    const seen: string[] = [];
    const memory = {
      check(id: string, dir: string) {
        seen.push(`${id}@${dir}`);
        return id === "m-1" ? "veraltet" : null;
      },
    };
    expect(checkEvidence(memEv, ctx(cwd, { memory }))).toContain("veraltet");
    expect(seen).toEqual([`m-1@${cwd}`]);
    expect(checkEvidence({ type: "memory", id: "m-2" }, ctx(cwd, { memory }))).toBeNull();
    expect(checkEvidence(memEv, ctx(cwd))).toContain("Memory nicht verfügbar");
  });
});
