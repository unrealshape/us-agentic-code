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
