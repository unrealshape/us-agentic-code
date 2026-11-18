/**
 * Abnahme Phase 4, Task 6: Gate-Stufen 3 bis 6.
 * Testprofile liegen in einem temporaeren Plugin-Ordner mit Stub-Befehlen; kein echtes Werkzeug noetig.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GateProfile, loadGateProfile } from "../../packages/daemon/src/config";
import { git } from "../../packages/daemon/src/exec";
import { runStages, type StageContext } from "../../packages/daemon/src/gates";
import { openStore, type Store } from "../../packages/daemon/src/store";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function plugin(profiles: Record<string, string>, shared: Record<string, string> = {}): string {
  const root = tmp("usac-gs-plugin-");
  mkdirSync(join(root, "gate-profiles", "_shared"), { recursive: true });
  for (const [n, y] of Object.entries(profiles)) writeFileSync(join(root, "gate-profiles", `${n}.yaml`), y);
  for (const [n, y] of Object.entries(shared)) writeFileSync(join(root, "gate-profiles", "_shared", `${n}.yaml`), y);
  return root;
}

function newStore(): { store: Store; wi: string } {
  const store = openStore(join(tmp("usac-gs-store-"), "s.db"));
  const wi = store.createWorkItem({ id: "wi_g", projectPath: "p", type: "feature", title: "t", description: "", size: "small" });
  return { store, wi: wi.id };
}

const ctx = (over: Partial<StageContext> = {}): StageContext => ({ workItemType: "feature", baseRef: "HEAD", env: {}, ...over });

function profile(stages: unknown[], extra: Record<string, unknown> = {}): GateProfile {
  return GateProfile.parse({ name: "t", acceptance: { run: "true" }, stages, ...extra });
}

async function repoWithBase(): Promise<{ dir: string; base: string }> {
  const dir = tmp("usac-gs-repo-");
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.invalid");
  await git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  return { dir, base: await git(dir, "rev-parse", "HEAD") };
}

describe("Gate-Stufen 3 bis 6", () => {
  test("Pflichtwerkzeug fehlt", async () => {
    const root = plugin({
      p: [
        "name: p",
        "acceptance: { run: 'true' }",
        "stages:",
        "  - name: sec",
        "    run: usac-gibt-es-nicht",
        "    stage: 4",
        "    optional: true",
        "    required_in: [security-fix]",
      ].join("\n"),
    });
    const gp = loadGateProfile(root, "p");
    const cwd = tmp("usac-gs-cwd-");
    const a = newStore();
    const sec = await runStages(a.store, a.wi, gp, cwd, 6, ctx({ workItemType: "security-fix" }));
    expect(sec.results[0]!.status).toBe("failed");
    expect(sec.passed).toBe(false);
    const b = newStore();
    const feat = await runStages(b.store, b.wi, gp, cwd, 6, ctx({ workItemType: "feature" }));
    expect(feat.results[0]!.status).toBe("skipped");
    expect(feat.passed).toBe(true);
  });

  test("includes lädt geteilte Stufen", () => {
    const gp = loadGateProfile(REPO_ROOT, "typescript");
    for (const n of ["semgrep", "gitleaks", "trivy"]) {
      const s = gp.stages.find((x) => x.name === n);
      expect(s).toBeDefined();
      expect(s!.stage).toBe(4);
      expect(s!.optional).toBe(true);
      expect(s!.required_in).toEqual(["security-fix", "dependency-update"]);
    }
  });

  test("includes in einem Testprofil haengt die Stufen an", () => {
    const root = plugin(
      { p: "name: p\nincludes: [extra]\nacceptance: { run: 'true' }\nstages:\n  - name: eigen\n    run: 'true'\n" },
      { extra: "stages:\n  - name: geteilt\n    run: 'true'\n    stage: 4\n" },
    );
    const gp = loadGateProfile(root, "p");
    expect(gp.stages.map((s) => s.name)).toEqual(["eigen", "geteilt"]);
  });

  test("{base} wird ersetzt", async () => {
    const { dir, base } = await repoWithBase();
    const { store, wi } = newStore();
    const run = await runStages(store, wi, profile([{ name: "b", run: "echo {base}", stage: 4 }]), dir, 6, ctx({ baseRef: base }));
    expect(run.results[0]!.output).toContain(base);
  });

  test("Umgebung erreicht das Gate", async () => {
    const { store, wi } = newStore();
    const run = await runStages(
      store,
      wi,
      profile([{ name: "e", run: "echo $BASE_URL", stage: 3 }]),
      tmp("usac-gs-cwd-"),
      6,
      ctx({ env: { BASE_URL: "http://127.0.0.1:4567" } }),
    );
    expect(run.results[0]!.output).toContain("http://127.0.0.1:4567");
  });

  test("coverage_diff unter Schwelle scheitert", async () => {
    const { dir, base } = await repoWithBase();
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
    // Geaendert: Zeilen 2 und 3; abgedeckt nur Zeile 2 -> 50 %.
    writeFileSync(join(dir, "lcov.info"), ["SF:src/a.ts", "DA:1,1", "DA:2,1", "DA:3,0", "end_of_record", ""].join("\n"));
    const { store, wi } = newStore();
    const gp = profile([{ name: "coverage_diff", internal: "coverage_diff", stage: 5 }], {
      coverage: { lcov: "lcov.info", include: ["src/**"], threshold: 0.8 },
    });
    const run = await runStages(store, wi, gp, dir, 6, ctx({ baseRef: base }));
    const r = run.results[0]!;
    expect(r.name).toBe("coverage_diff");
    expect(r.status).toBe("failed");
    expect(r.output).toContain("src/a.ts");
    expect(r.output).toContain("3");
    expect(run.passed).toBe(false);
  });

  test("coverage_diff ueber Schwelle besteht", async () => {
    const { dir, base } = await repoWithBase();
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(dir, "lcov.info"), ["SF:src/a.ts", "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n"));
    const { store, wi } = newStore();
    const gp = profile([{ name: "coverage_diff", internal: "coverage_diff", stage: 5 }], {
      coverage: { lcov: "lcov.info", include: ["src/**"], threshold: 0.8 },
    });
    const run = await runStages(store, wi, gp, dir, 6, ctx({ baseRef: base }));
    expect(run.results[0]!.status).toBe("passed");
  });

  test("criteria_evidence ohne Marke scheitert", async () => {
    const dir = tmp("usac-gs-crit-");
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/s1.test.ts"), "test('ohne Marke', () => {});\n");
    const { store, wi } = newStore();
    const gate = store.recordGate({ workItemId: wi, name: "acceptance", status: "passed", exitCode: 0, durationMs: 1, output: "" });
    const gp = profile([{ name: "criteria_evidence", internal: "criteria_evidence", stage: 6 }]);
    const run = await runStages(store, wi, gp, dir, 6, ctx({
      criteria: {
        cwd: dir,
        criteria: [{ id: "AC-1", given: "g", when: "w", then: "t", source: "task" }],
        slices: [{ id: "S1", title: "s", criteria: ["AC-1"], files: ["src/a.ts"], depends_on: [] }],
        sliceTests: { S1: ["tests/s1.test.ts"] },
        sliceGates: { S1: gate },
      },
    }));
    const r = run.results.find((x) => x.name === "criteria_evidence")!;
    expect(r.status).toBe("failed");
    expect(r.output).toContain("AC-1");
    expect(run.passed).toBe(false);
  });

  test("minStage", async () => {
    const { store, wi } = newStore();
    const gp = profile([
      { name: "eins", run: "true", stage: 1 },
      { name: "drei", run: "true", stage: 3 },
    ]);
    const run = await runStages(store, wi, gp, tmp("usac-gs-cwd-"), 6, ctx(), 3);
    expect(run.results.map((r) => r.name)).toEqual(["drei"]);
  });

  test("bestehende Profile laden unverändert", () => {
    const gp = loadGateProfile(REPO_ROOT, "lua");
    expect(gp.includes).toEqual([]);
    expect(gp.coverage).toBeUndefined();
    expect(gp.stages.map((s) => s.name)).toEqual(["format", "lint", "unit", "coverage"]);
    for (const s of gp.stages) expect(s.required_in).toEqual([]);
  });
});
