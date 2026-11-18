import type { GateProfile, GateStage } from "./config";
import { sh } from "./exec";
import type { GateResult, Store } from "./store";

export interface GateRun {
  passed: boolean;
  results: GateResult[];
  /** Zusammengefasste Ausgabe der fehlgeschlagenen Gates, fuer den naechsten Versuch. */
  failureOutput: string;
}

/** Fuehrt ein einzelnes Gate aus. Exit-Code 0 = bestanden. Fehlt ein optionales Werkzeug (127), wird uebersprungen. */
export async function runGate(store: Store, workItemId: string, stage: Pick<GateStage, "name" | "run" | "optional" | "timeout_ms">, cwd: string): Promise<GateResult> {
  const res = await sh(stage.run, cwd, stage.timeout_ms);
  let status: GateResult["status"] = res.exitCode === 0 ? "passed" : "failed";
  if (res.exitCode === 127 && stage.optional) status = "skipped";
  return store.recordGate({
    workItemId,
    name: stage.name,
    status,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: res.output,
  });
}

/** Fuehrt alle Gates bis einschliesslich maxStage aus. */
export async function runStages(store: Store, workItemId: string, profile: GateProfile, cwd: string, maxStage: number): Promise<GateRun> {
  const results: GateResult[] = [];
  for (const stage of profile.stages.filter((s) => s.stage <= maxStage)) {
    results.push(await runGate(store, workItemId, stage, cwd));
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
