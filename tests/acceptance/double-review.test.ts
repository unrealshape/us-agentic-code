/**
 * Abnahme Phase 2, Task 3: Doppel-Review bei Groesse large und bei Security-Triggern.
 * Beide Sitze laufen unabhaengig auf Opus; Fable wird im Review nie gerufen (ADR 0004).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { registerPhase, restorePhases, snapshotPhases } from "../../packages/daemon/src/phases";
import { createReviewHandler } from "../../packages/daemon/src/review";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";

let snap: ReturnType<typeof snapshotPhases>;
beforeEach(() => {
  snap = snapshotPhases();
  registerPhase("review", createReviewHandler());
});
afterEach(() => restorePhases(snap));

const ACC_PATH = "spec/acceptance/cooldown_spec.lua";

const testEngineerOk: Handler = async (spec) => {
  mkdirSync(join(spec.cwd, "spec/acceptance"), { recursive: true });
  writeFileSync(join(spec.cwd, ACC_PATH), ACCEPTANCE_SPEC);
  return { output: { summary: "Abnahmetest geschrieben", acceptance_tests: [ACC_PATH], claims: [] } };
};

const implementerOk: Handler = async (spec) => {
  writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
  return { output: { summary: "Cooldown-Pruefung ergaenzt", changed_files: ["src/rotation.lua"], claims: [] } };
};

/** Fix plus eine Datei unter src/auth/ (loest den Security-Trigger "auth" aus). */
const implementerAuth: Handler = async (spec) => {
  writeFileSync(join(spec.cwd, "src/rotation.lua"), FIXED_ROTATION);
  mkdirSync(join(spec.cwd, "src/auth"), { recursive: true });
  writeFileSync(join(spec.cwd, "src/auth/token.lua"), "return {}\n");
  return { output: { summary: "Fix und Token-Modul", changed_files: ["src/rotation.lua", "src/auth/token.lua"], claims: [] } };
};

const noop: Handler = async () => ({ output: { summary: "nichts geaendert", changed_files: [], claims: [] } });

const approve = (summary: string): Handler => async () => ({ output: { verdict: "approve", summary, findings: [], claims: [] } });

const HIGH_TEXT = "Bedingung prueft den Cooldown nur oberflaechlich";
const requestHigh: Handler = async () => ({
  output: {
    verdict: "request_changes",
    summary: "Ein schwerer Befund",
    findings: [
      {
        severity: "high",
        text: HIGH_TEXT,
        evidence: [
          { type: "file", path: "src/rotation.lua", lines: [10, 10], quote: "if ready and (best == nil or spell.priority > best.priority) then" },
        ],
      },
    ],
    claims: [],
  },
});

function setup(handlers: Record<string, Handler | Handler[]>, budgetUsed?: () => number) {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner(handlers);
  const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: ["h1", "h2"] }, graphify: false, budgetUsed });
  return { project, store, runner, orch };
}

const reviewCalls = (runner: ScriptedRunner) => runner.calls.filter((c) => c.role === "code-reviewer" || c.role === "security-reviewer");

describe("Doppel-Review", () => {
  test("large: zwei unabhaengige Reviews auf Opus", async () => {
    const { project, store, runner, orch } = setup({
      "test-engineer": testEngineerOk,
      implementer: implementerOk,
      "code-reviewer": [approve("ERSTES-URTEIL-A1"), approve("ZWEITES-URTEIL-B2")],
    });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x", size: "large" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");

    const calls = reviewCalls(runner);
    expect(calls.map((c) => c.role)).toEqual(["code-reviewer", "code-reviewer"]);
    expect(calls.map((c) => c.model)).toEqual(["opus", "opus"]);
    expect(calls[0]!.prompt).not.toContain("ZWEITES-URTEIL-B2");
    expect(calls[1]!.prompt).not.toContain("ERSTES-URTEIL-A1");

    const seats = store.events({ traceId: wi.id }).filter((e) => e.type === "review.seat").map((e) => e.data);
    expect(seats).toMatchObject([
      { role: "code-reviewer", reason: "standard", model: "opus", verdict: "approve" },
      { role: "code-reviewer", reason: "size_large", model: "opus", verdict: "approve" },
    ]);
    expect(store.events({ traceId: wi.id }).map((e) => e.type)).toContain("review.approved");
  }, 60_000);

  test("Security-Trigger: Zweitpruefer ist security-reviewer auf Opus", async () => {
    const { project, store, runner, orch } = setup({
      "test-engineer": testEngineerOk,
      implementer: implementerAuth,
      "code-reviewer": approve("ok"),
      "security-reviewer": approve("sicher"),
    });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");

    const calls = reviewCalls(runner);
    expect(calls.map((c) => c.role)).toEqual(["code-reviewer", "security-reviewer"]);
    expect(calls.map((c) => c.model)).toEqual(["opus", "opus"]);
    expect(calls[1]!.prompt).toContain("auth");
    const trig = store.events({ traceId: wi.id }).find((e) => e.type === "review.triggers");
    expect(trig?.data).toMatchObject({ triggers: ["auth"] });
  }, 60_000);

  test("Fable wird nie gerufen", async () => {
    const { project, runner, orch } = setup(
      {
        "test-engineer": testEngineerOk,
        implementer: [noop, noop, noop, noop, implementerAuth],
        "code-reviewer": approve("ok"),
        "security-reviewer": approve("sicher"),
      },
      () => 0,
    );
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x", size: "large" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");
    expect(runner.calls.filter((c) => c.role === "implementer")).toHaveLength(5);
    expect(reviewCalls(runner).map((c) => c.model)).toEqual(["opus", "opus"]);
    expect(runner.calls.some((c) => c.model === "fable")).toBe(false);
  }, 90_000);

  test("ein high-Befund eines Sitzes blockiert", async () => {
    const { project, store, runner, orch } = setup({
      "test-engineer": testEngineerOk,
      implementer: implementerOk,
      "code-reviewer": [approve("ok"), requestHigh, approve("ok"), approve("ok")],
    });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x", size: "large" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");

    const events = store.events({ traceId: wi.id });
    const types = events.map((e) => e.type);
    const changes = events.find((e) => e.type === "review.changes_requested");
    expect(changes?.data).toMatchObject({ seat: { role: "code-reviewer", reason: "size_large" } });
    // Beide Sitze wurden gehoert, bevor entschieden wurde.
    expect(types.slice(0, types.indexOf("review.changes_requested")).filter((t) => t === "review.seat")).toHaveLength(2);
    const impl = runner.calls.filter((c) => c.role === "implementer");
    expect(impl).toHaveLength(2);
    expect(impl[1]!.prompt).toContain(HIGH_TEXT);
    expect(reviewCalls(runner)).toHaveLength(4);
  }, 90_000);

  test("Kontingent ueber 90 %: security-reviewer bleibt Opus, code-reviewer faellt auf Sonnet", async () => {
    const { project, runner, orch } = setup(
      {
        "test-engineer": testEngineerOk,
        implementer: implementerAuth,
        "code-reviewer": approve("ok"),
        "security-reviewer": approve("sicher"),
      },
      () => 0.95,
    );
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    const result = await orch.run(wi.id);
    expect(result.status).toBe("done");
    const calls = reviewCalls(runner);
    expect(calls.map((c) => [c.role, c.model])).toEqual([
      ["code-reviewer", "sonnet"],
      ["security-reviewer", "opus"],
    ]);
  }, 60_000);
});
