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

/** Fuehrt den Abnahmetest aus. {files} wird durch die Testdateien ersetzt. */
export async function runAcceptance(store: Store, workItemId: string, profile: GateProfile, cwd: string, files: string[]): Promise<GateResult> {
  const quoted = files.map((f) => `'${f.replaceAll("'", "'\\''")}'`).join(" ");
  return runGate(
    store,
    workItemId,
    { name: "acceptance", run: profile.acceptance.run.replace("{files}", quoted), optional: false, timeout_ms: profile.acceptance.timeout_ms },
    cwd,
  );
}

export function summarize(results: GateResult[]): GateRun {
  const failed = results.filter((r) => r.status === "failed");
  return {
    passed: failed.length === 0,
    results,
    failureOutput: failed.map((r) => `### Gate "${r.name}" (Exit ${r.exitCode})\n${r.output}`).join("\n\n"),
  };
}
