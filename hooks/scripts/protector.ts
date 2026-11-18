#!/usr/bin/env bun
/**
 * Protector (PreToolUse-Hook, Idee aus Ruflo plugins/ruflo-protector):
 * Wenige, eng gefasste Regeln, die gefaehrliche Aktionen blockieren.
 * Die Bash-Sandbox deckt nur Bash ab; dieser Hook ist die zweite Linie fuer Datei-Tools.
 * Exit 2 = blockieren; bei eigenen Fehlern wird nicht blockiert (fail-open).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const GENERIC_PROTECTED = [
  ".usac/**",
  ".github/**",
  ".luacheckrc",
  ".busted",
  ".stylua.toml",
  "stylua.toml",
  ".luarc.json",
  "tsconfig.json",
  "biome.json",
  "eslint.config.*",
  ".eslintrc*",
  "vitest.config.*",
];

const BASH_RULES: Array<[RegExp, string]> = [
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "Remote-Code direkt in eine Shell (PR-002)"],
  [/\bgit\s+push\b[^\n]*(\s--force(?!-with-lease)\b|\s-f\b)/, "git push --force"],
  [/\bgit\s+push\b[^\n]*\b(main|master)\b/, "Push auf main/master"],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\/\*?)/i, "rm -rf auf / oder Home"],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "destruktives SQL"],
  [/\bgit\s+reset\s+--hard\s+origin\//, "git reset --hard auf Remote-Stand"],
  [/(~|\$HOME)\/\.(ssh|aws|gnupg)\b/, "Zugriff auf Schluessel-Ordner"],
];

function block(reason: string): never {
  console.error(`Protector: blockiert - ${reason}`);
  process.exit(2);
}

function protectedGlobs(cwd: string): string[] {
  try {
    const profilePath = join(cwd, ".usac/project.yaml");
    if (existsSync(profilePath)) {
      const { parse } = require("yaml");
      const { readFileSync } = require("node:fs");
      const profile = parse(readFileSync(profilePath, "utf8"));
      const gp = join(process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, "../.."), "gate-profiles", `${profile.gate_profile}.yaml`);
      if (existsSync(gp)) {
        const g = parse(readFileSync(gp, "utf8"));
        return [...GENERIC_PROTECTED, ...(g.protected_globs ?? [])];
      }
    }
  } catch {
    // fail-open: generische Liste
  }
  return GENERIC_PROTECTED;
}

try {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  const tool: string = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const cwd: string = input.cwd ?? process.cwd();

  if (tool === "Bash") {
    const cmd: string = ti.command ?? "";
    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) block(reason);
    process.exit(0);
  }

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const raw: string = ti.file_path ?? ti.notebook_path ?? "";
    if (!raw) process.exit(0);
    const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    const rel = relative(resolve(cwd), abs);
    if (rel.startsWith("..") || isAbsolute(rel)) block(`Schreiben ausserhalb des Arbeitsordners: ${abs}`);
    if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example")) block(`Secrets-Datei: ${rel}`);
    for (const g of protectedGlobs(cwd)) {
      if (new Bun.Glob(g).match(rel)) block(`geschuetzte Gate-Konfiguration: ${rel}`);
    }
  }
  process.exit(0);
} catch (err) {
  // fail-open: Fehler im Protector blockiert nie, wird aber gemeldet.
  console.error(`Protector degraded: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
