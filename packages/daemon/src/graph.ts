import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { git, sh } from "./exec";

/** Graphify-Anbindung: lokaler Wissensgraph je Projekt (tree-sitter, ohne LLM). */

export async function hasGraphify(): Promise<boolean> {
  const r = await sh("command -v graphify", process.cwd(), 5_000);
  return r.exitCode === 0;
}

export interface GraphUpdate {
  ok: boolean;
  nodes?: number;
  edges?: number;
  output: string;
}

export async function updateGraph(cwd: string): Promise<GraphUpdate> {
  const r = await sh("graphify update .", cwd, 10 * 60_000);
  const m = r.output.match(/Rebuilt:\s*(\d+)\s*nodes,\s*(\d+)\s*edges/);
  return {
    ok: r.exitCode === 0,
    nodes: m ? Number(m[1]) : undefined,
    edges: m ? Number(m[2]) : undefined,
    output: r.output.slice(-2000),
  };
}

/**
 * Knoten aus `graphify-out/graph.json`. Feldnamen belegt in tests/fixtures/graph/QUELLE.md
 * (graphify 0.9.65): `id`, `label`, `source_file`, `source_location` ("L<zeile>").
 */
export type GraphNode = { id: string; label: string; path: string; line?: number };

/** Liest den Graph eines Projekts; `null`, wenn graph.json fehlt oder unlesbar ist. Knoten ohne Quelldatei entfallen. */
export function loadGraph(cwd: string): GraphNode[] | null {
  const file = join(cwd, "graphify-out", "graph.json");
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const nodes = (raw as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const out: GraphNode[] = [];
  for (const n of nodes as Record<string, unknown>[]) {
    if (typeof n?.id !== "string" || typeof n.source_file !== "string" || !n.source_file) continue;
    const m = typeof n.source_location === "string" ? n.source_location.match(/^L(\d+)/) : null;
    out.push({
      id: n.id,
      label: typeof n.label === "string" ? n.label : n.id,
      path: n.source_file.replace(/\\/g, "/"),
      ...(m ? { line: Number(m[1]) } : {}),
    });
  }
  return out;
}

/** Knoten, deren Label oder ID mindestens ein Schluesselwort enthaelt; meiste Treffer zuerst. */
export function findNodes(nodes: GraphNode[], keywords: string[]): GraphNode[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return nodes
    .map((n) => {
      const hay = `${n.label} ${n.id}`.toLowerCase();
      return { n, hits: kws.filter((k) => hay.includes(k)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.n);
}

/** Traegt Pfade in .git/info/exclude ein (gilt fuer alle Worktrees eines Repos). */
export async function excludeFromGit(cwd: string, patterns: string[]): Promise<void> {
  let common = await git(cwd, "rev-parse", "--git-common-dir");
  if (!isAbsolute(common)) common = join(cwd, common);
  const file = join(common, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = patterns.filter((p) => !current.split("\n").includes(p));
  if (missing.length) appendFileSync(file, (current.endsWith("\n") || !current ? "" : "\n") + missing.join("\n") + "\n");
}
