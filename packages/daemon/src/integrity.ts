import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { matchesAny, type GateProfile } from "./config";
import { git } from "./exec";

// ---------------------------------------------------------------------------
// Testsperre: gesperrte Abnahmetests duerfen sich nicht aendern.
// ---------------------------------------------------------------------------

export function hashFiles(cwd: string, files: string[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(f);
    h.update("\0");
    h.update(existsSync(join(cwd, f)) ? readFileSync(join(cwd, f)) : "<fehlt>");
    h.update("\0");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Anti-Schummel: was hat der Implementer geaendert?
// ---------------------------------------------------------------------------

export interface Violation {
  path: string;
  reason: "locked_test" | "test_file" | "protected_file" | "skip_marker";
  detail?: string;
}

export async function changedFiles(cwd: string, baseRef: string): Promise<string[]> {
  const tracked = (await git(cwd, "diff", "--name-only", baseRef)).split("\n").filter(Boolean);
  const untracked = (await git(cwd, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

/** Prueft die Aenderungen einer Rolle, die keine Tests anfassen darf. */
export async function checkImplementerDiff(
  cwd: string,
  baseRef: string,
  profile: GateProfile,
  lockedFiles: string[],
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const path of await changedFiles(cwd, baseRef)) {
    if (lockedFiles.includes(path)) {
      violations.push({ path, reason: "locked_test" });
    } else if (matchesAny(path, profile.test_globs)) {
      violations.push({ path, reason: "test_file" });
    } else if (matchesAny(path, profile.protected_globs)) {
      violations.push({ path, reason: "protected_file" });
    } else if (profile.skip_markers.length && existsSync(join(cwd, path))) {
      const added = await addedLines(cwd, baseRef, path);
      const marker = profile.skip_markers.find((m) => added.some((l) => l.includes(m)));
      if (marker) violations.push({ path, reason: "skip_marker", detail: marker });
    }
  }
  return violations;
}

async function addedLines(cwd: string, baseRef: string, path: string): Promise<string[]> {
  let diff = "";
  try {
    diff = await git(cwd, "diff", baseRef, "--", path);
  } catch {
    diff = "";
  }
  if (!diff) {
    // Neue, ungetrackte Datei: alle Zeilen gelten als hinzugefuegt.
    return readFileSync(join(cwd, path), "utf8").split("\n");
  }
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Setzt Dateien auf den Stand von baseRef zurueck (neue Dateien werden geloescht). */
export async function revertPaths(cwd: string, baseRef: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await git(cwd, "cat-file", "-e", `${baseRef}:${p}`);
      await git(cwd, "checkout", baseRef, "--", p);
    } catch {
      rmSync(join(cwd, p), { force: true });
    }
  }
}
