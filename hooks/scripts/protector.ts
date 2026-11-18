#!/usr/bin/env bun
/**
 * Protector (PreToolUse-Hook, Idee aus Ruflo plugins/ruflo-protector):
 * Wenige, eng gefasste Regeln, die gefaehrliche Aktionen blockieren.
 * Die Bash-Sandbox deckt nur Bash ab; dieser Hook ist die zweite Linie fuer Datei-Tools.
 * Exit 2 = blockieren; bei eigenen Fehlern wird nicht blockiert (fail-open).
 *
 * Modi (USAC_PROTECTOR_MODE, sonst `.usac/project.yaml` -> protector.mode, sonst `blockieren`):
 *   blockieren: Exit 2;  melden: Exit 0 mit Meldung;  lernen: Exit 0, nur Log.
 * Unbekannte Werte gelten als `blockieren`. Ist USAC_HOOK_LOG gesetzt, wird jede Regel-Treffer-Entscheidung
 * als JSON-Zeile dorthin geschrieben; ein Fehler beim Loggen aendert die Entscheidung nicht.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { appendHookLog, parseProtectorMode, type HookLogEntry, type ProtectorMode } from "../../packages/daemon/src/hook-log";

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

let cachedProfile: { cwd: string; value: any } | undefined;

/** Liest `.usac/project.yaml` (oder undefined); Fehler werfen bewusst nach oben. */
function projectProfile(cwd: string): any {
  if (cachedProfile?.cwd === cwd) return cachedProfile.value;
  const profilePath = join(cwd, ".usac/project.yaml");
  let value: any;
  if (existsSync(profilePath)) {
    const { parse } = require("yaml");
    value = parse(readFileSync(profilePath, "utf8"));
  }
  cachedProfile = { cwd, value };
  return value;
}

function protectorMode(cwd: string): ProtectorMode {
  const env = process.env.USAC_PROTECTOR_MODE;
  if (env !== undefined && env.trim() !== "") return parseProtectorMode(env);
  try {
    return parseProtectorMode(projectProfile(cwd)?.protector?.mode);
  } catch {
    // Profil unlesbar: sicherer Standard
    return "blockieren";
  }
}

const ACTION: Record<ProtectorMode, HookLogEntry["action"]> = {
  blockieren: "blocked",
  melden: "reported",
  lernen: "learned",
};

/** Eine Regel hat gegriffen: loggen und je nach Modus blockieren (Exit 2) oder durchlassen (Exit 0). */
function decide(rule: string, tool: string, target: string, cwd: string): never {
  const mode = protectorMode(cwd);
  const logPath = process.env.USAC_HOOK_LOG;
  if (logPath) {
    try {
      appendHookLog(logPath, { ts: new Date().toISOString(), hook: "protector", mode, action: ACTION[mode], rule, tool, target });
    } catch (err) {
      console.error(`Protector: Hook-Log nicht schreibbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (mode === "blockieren") {
    console.error(`Protector: blockiert - ${rule}`);
    process.exit(2);
  }
  if (mode === "melden") console.error(`Protector: gemeldet (nicht blockiert) - ${rule}`);
  process.exit(0);
}

function protectedGlobs(cwd: string): string[] {
  try {
    const profile = projectProfile(cwd);
    if (profile) {
      const { parse } = require("yaml");
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
    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) decide(reason, tool, cmd, cwd);
    process.exit(0);
  }

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const raw: string = ti.file_path ?? ti.notebook_path ?? "";
    if (!raw) process.exit(0);
    const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    const rel = relative(resolve(cwd), abs);
    if (rel.startsWith("..") || isAbsolute(rel)) decide(`Schreiben ausserhalb des Arbeitsordners: ${abs}`, tool, abs, cwd);
    if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example")) decide(`Secrets-Datei: ${rel}`, tool, abs, cwd);
    for (const g of protectedGlobs(cwd)) {
      if (new Bun.Glob(g).match(rel)) decide(`geschuetzte Gate-Konfiguration: ${rel}`, tool, abs, cwd);
    }
  }
  process.exit(0);
} catch (err) {
  // fail-open: Fehler im Protector blockiert nie, wird aber gemeldet.
  console.error(`Protector degraded: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
