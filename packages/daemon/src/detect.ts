import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadGateProfile } from "./config";

/**
 * Erkennt die Stacks eines Projekts: zaehlt je Gate-Profil die von Git verfolgten Dateien,
 * die auf eines seiner `detect`-Globs passen. Profile ohne Treffer fallen weg.
 * Sortierung: absteigend nach Anzahl, bei Gleichstand alphabetisch nach Profil.
 */
export function detectStacks(projectPath: string, pluginRoot: string): { profile: string; files: number }[] {
  const res = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: projectPath, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ls-files in ${projectPath} fehlgeschlagen: ${res.stderr.toString().trim()}`);
  }
  const files = res.stdout.toString().split("\0").filter(Boolean);
  const names = readdirSync(join(pluginRoot, "gate-profiles"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
  const out: { profile: string; files: number }[] = [];
  for (const name of names) {
    const globs = loadGateProfile(pluginRoot, name).detect.map((g) => new Bun.Glob(g));
    const n = files.filter((f) => globs.some((g) => g.match(f))).length;
    if (n > 0) out.push({ profile: name, files: n });
  }
  return out.sort((a, b) => b.files - a.files || (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
}
