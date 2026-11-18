import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGateProfile, type GateProfile } from "../../packages/daemon/src/config";
import { detectStacks } from "../../packages/daemon/src/detect";
import { expandAcceptance, runAcceptance } from "../../packages/daemon/src/gates";
import { openStore } from "../../packages/daemon/src/store";
import { REPO_ROOT, setupProject, tempHome } from "../helpers";

const STACKS = ["python", "go", "rust", "dotnet", "java"];

describe("Stack-Profile (Phase 3, Task 10)", () => {
  test("jedes Stack-Profil laedt", () => {
    for (const n of STACKS) {
      const p = loadGateProfile(REPO_ROOT, n);
      expect(p.name).toBe(n);
      const stage1 = p.stages.filter((s) => s.stage === 1).map((s) => s.name);
      expect(stage1).toContain("lint");
      expect(stage1).toContain("unit");
      expect(p.network_allow.length).toBeGreaterThan(0);
      expect(p.test_globs.length).toBeGreaterThan(0);
      expect(p.protected_globs.length).toBeGreaterThan(0);
    }
  });

  test("Platzhalter", () => {
    expect(expandAcceptance("go test {dirs}", ["internal/a/x_test.go", "internal/a/y_test.go", "cmd/z_test.go"])).toBe(
      "go test './internal/a' './cmd'",
    );
    expect(expandAcceptance("mvn -q test -Dtest={stems_csv}", ["src/test/java/a/FooTest.java"])).toBe("mvn -q test -Dtest=FooTest");
    expect(expandAcceptance("x {stems_csv}", ["a/FooTest.java", "b/BarTest.java"])).toBe("x FooTest,BarTest");
    expect(expandAcceptance("for t in {stems}; do :; done", ["tests/a.rs", "tests/b.rs"])).toBe("for t in a b; do :; done");
    expect(expandAcceptance('dotnet test --filter "{dotnet_filter}"', ["t/A.cs", "t/B.cs"])).toBe(
      'dotnet test --filter "FullyQualifiedName~A|FullyQualifiedName~B"',
    );
    expect(expandAcceptance("pytest -q {files}", ["tests/a b.py", "tests/c.py"])).toBe("pytest -q 'tests/a b.py' 'tests/c.py'");
    expect(expandAcceptance("go test {dirs}", ["my dir/x_test.go"])).toBe("go test './my dir'");
  });

  for (const n of STACKS) {
    test(`Erkennung: ${n}-mini`, () => {
      const dir = setupProject(`${n}-mini`);
      const stacks = detectStacks(dir, REPO_ROOT);
      expect(stacks[0]?.profile).toBe(n);
      expect(readFileSync(join(dir, ".usac/project.yaml"), "utf8")).toContain(`gate_profile: ${n}`);
    });
  }

  test("Skills sind gueltig", () => {
    for (const n of STACKS) {
      const p = join(REPO_ROOT, "skills", n, "SKILL.md");
      expect(existsSync(p)).toBe(true);
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf8"));
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(new RegExp(`^name: ${n}\s*$`, "m"));
      expect(m![1]).toMatch(/^description: \S/m);
    }
  });

  const hasClaude = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  test.skipIf(!hasClaude)("claude plugin validate endet mit Exit 0", () => {
    const r = Bun.spawnSync(["claude", "plugin", "validate", "."], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
  });

  test("rot durch Build-Fehler wird markiert", async () => {
    const store = openStore(join(tempHome(), "s.db"));
    const wi = store.createWorkItem({ id: "wi_s", projectPath: "p", type: "bugfix", title: "t", description: "", size: "small" });
    const profile: GateProfile = {
      name: "x",
      detect: [],
      test_globs: [],
      protected_globs: [],
      skip_markers: [],
      network_allow: [],
      acceptance: { run: "echo 'error[E0425]: nicht gefunden'; exit 1", timeout_ms: 20_000, build_error_patterns: ["error[[]E"] },
      stages: [],
    };
    const r = await runAcceptance(store, wi.id, profile, tempHome(), ["a.rs"]);
    expect(r.status).toBe("failed");
    expect(r.name).toBe("acceptance:build_error");
    const ok = await runAcceptance(store, wi.id, { ...profile, acceptance: { ...profile.acceptance, run: "echo 'assertion failed'; exit 1" } }, tempHome(), ["a.rs"]);
    expect(ok.name).toBe("acceptance");
  });

  /** `dotnet` allein kann nur die Runtime sein; fuer Build und Test braucht es ein SDK. */
  const hasDotnetSdk = (): boolean => {
    const r = Bun.spawnSync(["dotnet", "--list-sdks"], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 && r.stdout.toString().trim() !== "";
  };

  // Werkzeuglaeufe: nur mit USAC_TOOLCHAIN_TESTS=1 und vorhandenem Werkzeug.
  const tools: Record<string, string> = { python: "ruff", go: "go", rust: "cargo", dotnet: "dotnet", java: "mvn" };
  for (const n of STACKS) {
    const on = process.env.USAC_TOOLCHAIN_TESTS === "1" && Bun.which(tools[n]!) !== null && (n !== "dotnet" || hasDotnetSdk());
    test.skipIf(!on)(`Werkzeuglauf Stufe 1: ${n}-mini`, async () => {
      const dir = setupProject(`${n}-mini`);
      const profile = loadGateProfile(REPO_ROOT, n);
      const { runStages } = await import("../../packages/daemon/src/gates");
      const store = openStore(join(tempHome(), "s.db"));
      const wi = store.createWorkItem({ id: "wi_s", projectPath: "p", type: "bugfix", title: "t", description: "", size: "small" });
      const run = await runStages(store, wi.id, profile, dir, 1);
      expect(run.failureOutput).toBe("");
      expect(run.passed).toBe(true);
    }, 600_000);
  }
});
