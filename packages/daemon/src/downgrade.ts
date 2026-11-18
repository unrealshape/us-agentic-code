// Vorschlaege zum Herabstufen von Modellen (Phase 5, ADR 0010).
// Deterministisch: feste Schwellen im Code, kein LLM. Uebernahme nur ueber Freigabe;
// Aenderungen landen in `<home>/routing.override.yaml`, `routing.yaml` im Plugin bleibt unveraendert.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { MODELS, type Model } from "@usac/shared";
import type { RoleModelStats } from "./metrics";
import { loadRoutingOverride, RoutingOverride, type RoutingConfig } from "./routing";

export { RoutingOverride } from "./routing";

export const DOWNGRADE_DEFAULTS = {
  minRuns: 20,
  minFirstPass: 0.9,
  maxEscalations: 0,
  trialRuns: 10,
  revertBelow: 0.8,
  /** Steuernde Rollen werden nie herabgestuft. */
  exclude: ["analyst", "tech-lead", "code-reviewer", "security-reviewer", "architect"],
};
export type DowngradeOptions = typeof DOWNGRADE_DEFAULTS;

export type DowngradeSuggestion = {
  role: string;
  variant?: string;
  from: Model;
  to: Model;
  evidence: { runs: number; firstPassRate: number; escalations: number };
};

const opt = (o?: Partial<DowngradeOptions>): DowngradeOptions => ({ ...DOWNGRADE_DEFAULTS, ...o });

/** Schluessel in `defaults`/`trials` der Override-Datei: Rolle oder `rolle.variante`. */
export const overrideKey = (role: string, variant?: string): string => (variant ? `${role}.${variant}` : role);
const roleOfKey = (key: string): string => (key.includes(".") ? key.slice(0, key.indexOf(".")) : key);

/**
 * Schlaegt je Rolle eine Stufe tiefer vor, wenn das aktuelle Standardmodell der Rolle `from` ist und
 * die Kennzahlen auf `from` die Schwellen erreichen. Nie unter Haiku, nie fuer ausgeschlossene Rollen.
 * Rollen mit Varianten: haben alle Varianten das Modell `from`, gilt der Vorschlag fuer die ganze Rolle;
 * sonst je Variante auf `from` (die Kennzahlen unterscheiden Varianten nicht).
 */
export function suggestDowngrades(
  stats: RoleModelStats[],
  cfg: RoutingConfig,
  opts?: Partial<DowngradeOptions>,
): DowngradeSuggestion[] {
  const o = opt(opts);
  const out: DowngradeSuggestion[] = [];
  for (const s of stats) {
    if (o.exclude.includes(s.role)) continue;
    const def = cfg.defaults[s.role];
    if (!def) continue;
    const i = MODELS.indexOf(s.model);
    if (i <= 0) continue;
    if (s.runs < o.minRuns || s.firstPassRate < o.minFirstPass || s.escalations > o.maxEscalations) continue;
    const to = MODELS[i - 1]!;
    const evidence = { runs: s.runs, firstPassRate: s.firstPassRate, escalations: s.escalations };
    if (typeof def === "string") {
      if (def === s.model) out.push({ role: s.role, from: s.model, to, evidence });
      continue;
    }
    const variants = Object.entries(def);
    const onFrom = variants.filter(([, m]) => m === s.model).map(([v]) => v);
    if (!onFrom.length) continue;
    if (onFrom.length === variants.length) out.push({ role: s.role, from: s.model, to, evidence });
    else for (const variant of onFrom) out.push({ role: s.role, variant, from: s.model, to, evidence });
  }
  return out;
}

function writeOverride(path: string, ov: RoutingOverride): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(RoutingOverride.parse(ov)));
}

/** Uebernimmt einen (freigegebenen) Vorschlag: `defaults[rolle] = to` und ein Probeeintrag. */
export function applyDowngrade(overridePath: string, s: DowngradeSuggestion, now: Date): void {
  const ov = loadRoutingOverride(overridePath);
  const key = overrideKey(s.role, s.variant);
  ov.defaults[key] = s.to;
  ov.trials[key] = { from: s.from, to: s.to, startedAt: now.toISOString(), runs: 0 };
  writeOverride(overridePath, ov);
}

/**
 * Wertet laufende Proben aus. `stats` muessen aus den Events seit Probebeginn (`startedAt`) stammen.
 * Nach `trialRuns` Laeufen auf `to`: Erstversuchs-Quote < `revertBelow` -> zurueck auf `from`, sonst bestaetigt.
 * In beiden Faellen ist die Probe beendet. Davor wird nur der Laufzaehler nachgefuehrt.
 */
export function evaluateTrials(
  overridePath: string,
  stats: RoleModelStats[],
  opts?: Partial<DowngradeOptions>,
): { reverted: string[]; confirmed: string[] } {
  const o = opt(opts);
  const ov = loadRoutingOverride(overridePath);
  const reverted: string[] = [];
  const confirmed: string[] = [];
  let changed = false;
  for (const [key, trial] of Object.entries(ov.trials)) {
    const st = stats.find((x) => x.role === roleOfKey(key) && x.model === trial.to);
    const runs = st?.runs ?? 0;
    if (runs !== trial.runs) {
      trial.runs = runs;
      changed = true;
    }
    if (!st || runs < o.trialRuns) continue;
    if (st.firstPassRate < o.revertBelow) {
      ov.defaults[key] = trial.from;
      reverted.push(key);
    } else confirmed.push(key);
    delete ov.trials[key];
    changed = true;
  }
  if (changed) writeOverride(overridePath, ov);
  return { reverted, confirmed };
}
