/**
 * Hook-Log: eine JSON-Zeile je Hook-Entscheidung (Protector, GateGuard).
 * Nur `node:fs`/`node:path` als Abhaengigkeit, damit die Hooks diese Datei direkt importieren koennen.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type ProtectorMode = "lernen" | "melden" | "blockieren";

export const PROTECTOR_MODES: readonly ProtectorMode[] = ["lernen", "melden", "blockieren"];

/** Unbekannt, leer oder falscher Typ -> `blockieren` (ein Tippfehler darf den Schutz nie abschalten). */
export function parseProtectorMode(raw: unknown): ProtectorMode {
  if (typeof raw !== "string") return "blockieren";
  const v = raw.trim();
  return (PROTECTOR_MODES as readonly string[]).includes(v) ? (v as ProtectorMode) : "blockieren";
}

export type HookLogEntry = {
  ts: string;
  hook: "protector" | "gateguard";
  mode?: ProtectorMode;
  action: "blocked" | "reported" | "learned" | "denied" | "allowed";
  rule?: string;
  tool: string;
  target: string;
};

export function appendHookLog(path: string, e: HookLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(e)}\n`, "utf8");
}

/** Liest alle gueltigen Zeilen; kaputte oder abgeschnittene Zeilen werden uebersprungen. */
export function readHookLog(path: string): HookLogEntry[] {
  if (!existsSync(path)) return [];
  const out: HookLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && typeof v.hook === "string" && typeof v.action === "string") out.push(v as HookLogEntry);
    } catch {
      // abgeschnittene Zeile: ueberspringen
    }
  }
  return out;
}
