import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "../../packages/shared/src/index";
import { REPO_ROOT } from "../helpers";
import type { RoleModelStats } from "../../packages/daemon/src/metrics";
import { loadRouting, resolveModel } from "../../packages/daemon/src/routing";
import { applyDowngrade, DOWNGRADE_DEFAULTS, evaluateTrials, suggestDowngrades } from "../../packages/daemon/src/downgrade";

function stat(role: string, model: Model, runs: number, firstPassRate: number, escalations = 0): RoleModelStats {
  return { role, model, runs, okRuns: runs, firstPassRate, escalations, tokens: 0, avgTurns: 0 };
}

const overrideFile = () => join(mkdtempSync(join(tmpdir(), "usac-downgrade-")), "routing.override.yaml");
const NOW = new Date("2026-11-18T10:00:00.000Z");

describe("Herabstufung", () => {
  const cfg = loadRouting(REPO_ROOT);

  test("Schwellen sind feste Konstanten", () => {
    expect(DOWNGRADE_DEFAULTS).toEqual({
      minRuns: 20,
      minFirstPass: 0.9,
      maxEscalations: 0,
      trialRuns: 10,
      revertBelow: 0.8,
      exclude: ["analyst", "tech-lead", "code-reviewer", "security-reviewer", "architect"],
    });
  });

  test("Vorschlag ab 20 Läufen mit hoher Quote", () => {
    const s = suggestDowngrades([stat("implementer", "sonnet", 25, 0.96)], cfg);
    expect(s).toEqual([
      { role: "implementer", from: "sonnet", to: "haiku", evidence: { runs: 25, firstPassRate: 0.96, escalations: 0 } },
    ]);
  });

  test("zu wenige Läufe", () => {
    expect(suggestDowngrades([stat("implementer", "sonnet", 19, 1)], cfg)).toEqual([]);
    expect(suggestDowngrades([stat("implementer", "sonnet", 20, 0.9)], cfg)).toHaveLength(1);
  });

  test("steuernde Rollen nie", () => {
    for (const role of DOWNGRADE_DEFAULTS.exclude) {
      expect(suggestDowngrades([stat(role, "opus", 100, 1)], cfg)).toEqual([]);
    }
  });

  test("nie unter Haiku", () => {
    expect(suggestDowngrades([stat("explorer", "haiku", 100, 1)], cfg)).toEqual([]);
  });

  test("Eskalation verhindert Vorschlag", () => {
    expect(suggestDowngrades([stat("implementer", "sonnet", 50, 1, 1)], cfg)).toEqual([]);
  });

  test("nur wenn das Standardmodell der Rolle `from` ist", () => {
    // implementer laeuft standardmaessig auf sonnet; Opus-Laeufe stammen aus Anhebungen.
    expect(suggestDowngrades([stat("implementer", "opus", 50, 1)], cfg)).toEqual([]);
  });

  test("Variante wird nur gemeinsam herabgestuft, wenn alle Varianten dasselbe Modell haben", () => {
    const s = suggestDowngrades([stat("test-engineer", "sonnet", 30, 0.95)], cfg);
    expect(s).toHaveLength(1);
    expect(s[0]!.from).toBe("sonnet");
    expect(s[0]!.to).toBe("haiku");
  });

  test("Override wirkt nur auf defaults", () => {
    const path = overrideFile();
    const [s] = suggestDowngrades([stat("implementer", "sonnet", 25, 0.96)], cfg);
    applyDowngrade(path, s!, NOW);
    const merged = loadRouting(REPO_ROOT, path);
    expect(resolveModel(merged, "implementer").model).toBe("haiku");
    expect(merged.fable.only_roles).toEqual(["architect"]);
    expect(merged.budget).toEqual(cfg.budget);
    expect(merged.raise).toEqual(cfg.raise);
    expect(resolveModel(merged, "explorer").model).toBe("haiku");
    expect(resolveModel(merged, "code-reviewer").model).toBe("opus");
    // Ohne Override-Datei (oder fehlende Datei) bleibt alles beim Plugin-Stand.
    expect(resolveModel(loadRouting(REPO_ROOT, join(tmpdir(), "gibt-es-nicht.yaml")), "implementer").model).toBe("sonnet");
  });

  test("Probe laeuft weiter, solange zu wenige Laeufe vorliegen", () => {
    const path = overrideFile();
    const [s] = suggestDowngrades([stat("implementer", "sonnet", 25, 0.96)], cfg);
    applyDowngrade(path, s!, NOW);
    const r = evaluateTrials(path, [stat("implementer", "haiku", 9, 0.1)]);
    expect(r).toEqual({ reverted: [], confirmed: [] });
    expect(resolveModel(loadRouting(REPO_ROOT, path), "implementer").model).toBe("haiku");
  });

  test("Probe wird bei Verschlechterung zurückgenommen", () => {
    const path = overrideFile();
    const [s] = suggestDowngrades([stat("implementer", "sonnet", 25, 0.96)], cfg);
    applyDowngrade(path, s!, NOW);
    const r = evaluateTrials(path, [stat("implementer", "haiku", 10, 0.6)]);
    expect(r.reverted).toContain("implementer");
    expect(r.confirmed).toEqual([]);
    expect(resolveModel(loadRouting(REPO_ROOT, path), "implementer").model).toBe("sonnet");
    // Probe ist beendet: eine zweite Auswertung aendert nichts.
    expect(evaluateTrials(path, [stat("implementer", "haiku", 20, 0.1)])).toEqual({ reverted: [], confirmed: [] });
  });

  test("Probe wird bestätigt", () => {
    const path = overrideFile();
    const [s] = suggestDowngrades([stat("implementer", "sonnet", 25, 0.96)], cfg);
    applyDowngrade(path, s!, NOW);
    const r = evaluateTrials(path, [stat("implementer", "haiku", 10, 0.95)]);
    expect(r).toEqual({ reverted: [], confirmed: ["implementer"] });
    expect(resolveModel(loadRouting(REPO_ROOT, path), "implementer").model).toBe("haiku");
  });
});
