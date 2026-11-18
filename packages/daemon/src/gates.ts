import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { WorkItemType } from "@usac/shared";
import type { GateProfile, GateStage } from "./config";
import { changedLines, coverageDiff, parseLcov } from "./coverage-diff";
import { criteriaEvidence } from "./criteria-evidence";
import { sh } from "./exec";
import type { GateResult, Store } from "./store";

export interface GateRun {
  passed: boolean;
  results: GateResult[];
  /** Zusammengefasste Ausgabe der fehlgeschlagenen Gates, fuer den naechsten Versuch. */
  failureOutput: string;
}

/** Kontext eines Gate-Laufs: Typ des Work-Items (Pflichtwerkzeuge), Basis-Commit (`{base}`), Umgebung (z. B. BASE_URL). */
export type StageContext = {
  workItemType: WorkItemType;
  baseRef: string;
  env: Record<string, string>;
  criteria?: Parameters<typeof criteriaEvidence>[0];
};

type ShellGate = { name: string; run: string; optional: boolean; timeout_ms: number; required_in?: WorkItemType[] };

/** Exit 127 bzw. fehlende Eingabe: `failed`, wenn der Typ das Werkzeug verlangt; sonst `skipped` bei `optional`. */
function missingStatus(stage: { optional: boolean; required_in?: WorkItemType[] }, workItemType?: WorkItemType): GateResult["status"] {
  if (workItemType !== undefined && (stage.required_in ?? []).includes(workItemType)) return "failed";
  return stage.optional ? "skipped" : "failed";
}

/**
 * Fuehrt ein einzelnes Gate aus. Exit-Code 0 = bestanden. Fehlt ein Werkzeug (127), wird ein optionales Gate
 * uebersprungen, ausser der Work-Item-Typ steht in `required_in`.
 */
export async function runGate(
  store: Store,
  workItemId: string,
  stage: ShellGate,
  cwd: string,
  opts: { workItemType?: WorkItemType; env?: Record<string, string> } = {},
): Promise<GateResult> {
  const res = await sh(stage.run, cwd, stage.timeout_ms, opts.env);
  let status: GateResult["status"] = res.exitCode === 0 ? "passed" : "failed";
  let output = res.output;
  if (res.exitCode === 127) {
    status = missingStatus(stage, opts.workItemType);
    if (status === "failed" && stage.optional) output = `Pflichtwerkzeug fuer ${opts.workItemType} fehlt (Exit 127).\n${output}`;
  }
  return store.recordGate({ workItemId, name: stage.name, status, exitCode: res.exitCode, durationMs: res.durationMs, output });
}

const pct = (r: number): string => `${Math.round(r * 1000) / 10} %`;

/** Gate-Stufe 5: Abdeckung der geaenderten Zeilen gegen `profile.coverage.threshold`. */
async function coverageGate(profile: GateProfile, stage: GateStage, cwd: string, ctx: StageContext): Promise<Omit<GateResult, "id" | "workItemId" | "durationMs">> {
  const cfg = profile.coverage;
  if (!cfg) return { name: stage.name, status: "failed", exitCode: 1, output: `Profil "${profile.name}" hat keinen Abschnitt coverage.` };
  const lcovPath = isAbsolute(cfg.lcov) ? cfg.lcov : join(cwd, cfg.lcov);
  if (!existsSync(lcovPath)) {
    return { name: stage.name, status: missingStatus(stage, ctx.workItemType), exitCode: 127, output: `lcov-Datei fehlt: ${cfg.lcov}` };
  }
  let changed: Map<string, number[]>;
  try {
    changed = await changedLines(cwd, ctx.baseRef, cfg.include);
  } catch (e) {
    return { name: stage.name, status: "failed", exitCode: 1, output: `Diff gegen ${ctx.baseRef} fehlgeschlagen: ${(e as Error).message}` };
  }
  const r = coverageDiff(parseLcov(readFileSync(lcovPath, "utf8"), cwd), changed);
  const ok = r.ratio >= cfg.threshold;
  const lines = [
    `Abdeckung geaenderter Zeilen: ${r.covered}/${r.total} (${pct(r.ratio)}), Schwelle ${pct(cfg.threshold)}`,
    ...(r.uncovered.length > 0 ? ["Nicht abgedeckt:", ...r.uncovered.map((u) => `  ${u.file}: ${u.lines.join(", ")}`)] : []),
  ];
  return { name: stage.name, status: ok ? "passed" : "failed", exitCode: ok ? 0 : 1, output: lines.join("\n") };
}

/** Gate-Stufe 6: jedes Akzeptanzkriterium braucht einen markierten, gruenen Abnahmetest. */
function criteriaGate(stage: GateStage, ctx: StageContext): Omit<GateResult, "id" | "workItemId" | "durationMs"> {
  if (!ctx.criteria) {
    return { name: stage.name, status: missingStatus(stage, ctx.workItemType), exitCode: 127, output: "Keine Akzeptanzkriterien uebergeben." };
  }
  const proofs = criteriaEvidence(ctx.criteria);
  const missing = proofs.filter((p) => p.status === "missing");
  const output =
    missing.length === 0
      ? `Alle ${proofs.length} Kriterien belegt: ${proofs.map((p) => `${p.criterion} (${p.tests.join(", ")})`).join("; ")}`
      : ["Fehlende Kriterien:", ...missing.map((p) => `  ${p.criterion}: ${p.reason ?? "ohne Nachweis"}`)].join("\n");
  return { name: stage.name, status: missing.length === 0 ? "passed" : "failed", exitCode: missing.length === 0 ? 0 : 1, output };
}

async function runInternal(store: Store, workItemId: string, profile: GateProfile, stage: GateStage, cwd: string, ctx?: StageContext): Promise<GateResult> {
  const started = Date.now();
  const r = !ctx
    ? { name: stage.name, status: "skipped" as const, exitCode: 127, output: "Internes Gate ohne Lauf-Kontext uebersprungen." }
    : stage.internal === "coverage_diff"
      ? await coverageGate(profile, stage, cwd, ctx)
      : criteriaGate(stage, ctx);
  return store.recordGate({ workItemId, ...r, durationMs: Date.now() - started });
}

/**
 * Fuehrt alle Gates der Stufen minStage..maxStage aus. `{base}` im Befehl wird durch `ctx.baseRef` ersetzt,
 * `ctx.env` ergaenzt die Umgebung; interne Gates (`coverage_diff`, `criteria_evidence`) laufen ohne Shell.
 */
export async function runStages(
  store: Store,
  workItemId: string,
  profile: GateProfile,
  cwd: string,
  maxStage: number,
  ctx?: StageContext,
  minStage = 1,
): Promise<GateRun> {
  const results: GateResult[] = [];
  // Stabil nach Stufe sortiert: per `includes` angehaengte Stufen laufen an ihrer Stelle.
  const due = profile.stages.filter((s) => s.stage >= minStage && s.stage <= maxStage).sort((a, b) => a.stage - b.stage);
  for (const stage of due) {
    if (stage.internal) {
      results.push(await runInternal(store, workItemId, profile, stage, cwd, ctx));
      continue;
    }
    const run = ctx ? stage.run!.replaceAll("{base}", shqIfNeeded(ctx.baseRef)) : stage.run!;
    results.push(await runGate(store, workItemId, { ...stage, run }, cwd, { workItemType: ctx?.workItemType, env: ctx?.env }));
  }
  return summarize(results);
}

const shq = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;
/** Nur quoten, wenn die Shell sonst etwas anderes daraus machen wuerde. */
const shqIfNeeded = (v: string): string => (/^[\w.,+@%=:\/-]+$/.test(v) ? v : shq(v));
const stemOf = (f: string): string => {
  const base = f.split("/").pop() ?? f;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
};

/**
 * Ersetzt die Platzhalter in `acceptance.run`:
 * {files} Pfade quotiert, {dirs} eindeutige Elternordner mit `./`-Praefix quotiert,
 * {stems} Dateinamen ohne Endung (Leerzeichen), {stems_csv} dito (Komma),
 * {dotnet_filter} `FullyQualifiedName~A|FullyQualifiedName~B`.
 */
export function expandAcceptance(run: string, files: string[]): string {
  const norm = files.map((f) => f.replaceAll("\\", "/"));
  const dirs = [
    ...new Set(
      norm.map((f) => {
        const i = f.lastIndexOf("/");
        return i < 0 ? "./" : `./${f.slice(0, i).replace(/^\.\//, "")}`;
      }),
    ),
  ];
  const stems = [...new Set(norm.map(stemOf))];
  const values: Record<string, string> = {
    files: files.map(shq).join(" "),
    dirs: dirs.map(shq).join(" "),
    stems: stems.map(shqIfNeeded).join(" "),
    stems_csv: shqIfNeeded(stems.join(",")),
    dotnet_filter: stems.map((s) => `FullyQualifiedName~${s.replaceAll('"', "")}`).join("|"),
  };
  return run.replace(/\{(files|dirs|stems_csv|stems|dotnet_filter)\}/g, (_m, k: string) => values[k]!);
}

/** Fuehrt den Abnahmetest aus. Platzhalter siehe expandAcceptance. Rot mit Build-Fehler-Treffer heisst `acceptance:build_error`. */
export async function runAcceptance(store: Store, workItemId: string, profile: GateProfile, cwd: string, files: string[]): Promise<GateResult> {
  const res = await runGate(
    store,
    workItemId,
    { name: "acceptance", run: expandAcceptance(profile.acceptance.run, files), optional: false, timeout_ms: profile.acceptance.timeout_ms },
    cwd,
  );
  if (res.status === "failed" && profile.acceptance.build_error_patterns.some((p) => new RegExp(p).test(res.output))) {
    return { ...res, name: "acceptance:build_error" };
  }
  return res;
}

export function summarize(results: GateResult[]): GateRun {
  const failed = results.filter((r) => r.status === "failed");
  return {
    passed: failed.length === 0,
    results,
    failureOutput: failed.map((r) => `### Gate "${r.name}" (Exit ${r.exitCode})\n${r.output}`).join("\n\n"),
  };
}
