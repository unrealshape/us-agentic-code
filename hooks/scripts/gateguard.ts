#!/usr/bin/env bun
/**
 * GateGuard (PreToolUse-Hook, Idee aus ECC skills/gateguard, eigene Umsetzung):
 * Die erste Aenderung je Datei und Session wird verweigert (Exit 2) und verlangt konkrete Fakten;
 * der naechste Versuch auf dieselbe Datei ist erlaubt.
 *
 * Aktiv nur bei USAC_GATEGUARD=1. Betroffen: Edit, Write, MultiEdit, NotebookEdit (nie Bash).
 * Zustand je Session: USAC_GATEGUARD_STATE, sonst `<tmpdir>/usac-gateguard-<session_id>.json`,
 * Schluessel = normalisierter Pfad relativ zu `cwd`.
 * Ausnahmen: USAC_GATEGUARD_EXEMPT (kommagetrennte Globs, relativ zu `cwd`).
 * Ist USAC_HOOK_LOG gesetzt, wird jede Entscheidung als JSON-Zeile geloggt.
 * Eigene Fehler blockieren nie (fail-open, Exit 0).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendHookLog, type HookLogEntry } from "../../packages/daemon/src/hook-log";

const TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const EDIT_FACTS = [
  "1. Alle Dateien, die diese Datei importieren oder laden (im Baum suchen, z. B. mit Grep/Glob).",
  "2. Die öffentlichen Funktionen, Klassen oder Module, die von der Änderung betroffen sind.",
  "3. Falls die Datei Daten liest oder schreibt: die Datenformate (Feldnamen, Struktur, Datumsformat; nur Beispielwerte, keine echten Daten).",
  "4. Den aktuellen Auftrag wörtlich zitiert.",
];

const WRITE_FACTS = [
  "1. Die Datei(en) und Zeile(n), die diese neue Datei aufrufen oder laden werden.",
  "2. Die Bestätigung, dass keine ähnliche vorhandene Datei denselben Zweck erfüllt (im Baum suchen, z. B. mit Grep/Glob).",
  "3. Falls die Datei Daten liest oder schreibt: die Datenformate (Feldnamen, Struktur, Datumsformat; nur Beispielwerte, keine echten Daten).",
  "4. Den aktuellen Auftrag wörtlich zitiert.",
];

/** Backslashes vereinheitlichen, absolut aufloesen, relativ zu cwd mit `/`; unter Windows ohne Gross/Klein-Unterschied. */
function normalizeKey(raw: string, cwd: string): string {
  const slashed = raw.replace(/\\/g, "/");
  const base = resolve(cwd.replace(/\\/g, "/"));
  const abs = isAbsolute(slashed) ? resolve(slashed) : resolve(base, slashed);
  let rel = relative(base, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) rel = abs;
  rel = rel.replace(/\\/g, "/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

function displayPath(raw: string, cwd: string): string {
  const slashed = raw.replace(/\\/g, "/");
  const base = resolve(cwd.replace(/\\/g, "/"));
  const abs = isAbsolute(slashed) ? resolve(slashed) : resolve(base, slashed);
  const rel = relative(base, abs);
  return (rel === "" || rel.startsWith("..") || isAbsolute(rel) ? abs : rel).replace(/\\/g, "/");
}

function statePath(sessionId: string): string {
  const env = process.env.USAC_GATEGUARD_STATE;
  if (env && env.trim()) return env;
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(tmpdir(), `usac-gateguard-${safe}.json`);
}

/** Fehlender oder kaputter Zustand gilt als leer. */
function readState(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}

function log(action: HookLogEntry["action"], tool: string, target: string, rule?: string): void {
  const p = process.env.USAC_HOOK_LOG;
  if (!p) return;
  try {
    appendHookLog(p, { ts: new Date().toISOString(), hook: "gateguard", action, ...(rule ? { rule } : {}), tool, target });
  } catch (err) {
    console.error(`GateGuard: Hook-Log nicht schreibbar: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function exemptGlobs(): string[] {
  return (process.env.USAC_GATEGUARD_EXEMPT ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

try {
  if (process.env.USAC_GATEGUARD !== "1") process.exit(0);
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  if (!input || typeof input !== "object") process.exit(0);
  const tool: string = input.tool_name ?? "";
  if (!TOOLS.includes(tool)) process.exit(0);
  const ti = input.tool_input ?? {};
  const raw: string = ti.file_path ?? ti.notebook_path ?? "";
  if (!raw) process.exit(0);
  const cwd: string = input.cwd ?? process.cwd();
  const key = normalizeKey(raw, cwd);
  const shown = displayPath(raw, cwd);

  for (const g of exemptGlobs()) {
    if (new Bun.Glob(g).match(shown)) {
      log("allowed", tool, shown, `Ausnahme: ${g}`);
      process.exit(0);
    }
  }

  const sp = statePath(String(input.session_id ?? ""));
  const state = readState(sp);
  if (state[key]) {
    log("allowed", tool, shown);
    process.exit(0);
  }

  const abs = isAbsolute(raw.replace(/\\/g, "/")) ? raw : join(cwd, raw);
  const isNew = tool === "Write" && !existsSync(abs);
  state[key] = new Date().toISOString();
  writeState(sp, state);
  log("denied", tool, shown, isNew ? "write-gate" : "edit-gate");
  const facts = isNew ? WRITE_FACTS : EDIT_FACTS;
  console.error(
    [`GateGuard: Bevor du ${shown} änderst, nenne diese Fakten:`, "", ...facts, "", "Danach den Aufruf unverändert wiederholen."].join("\n"),
  );
  process.exit(2);
} catch (err) {
  // fail-open: Fehler im GateGuard blockieren nie, werden aber gemeldet.
  console.error(`GateGuard degraded: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
