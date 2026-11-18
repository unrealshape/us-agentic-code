/**
 * Abnahme der CLI ueber den echten ClaudeRunner (Stream-JSON) mit nachgebautem claude-Binary.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, git, setupProject, tempHome } from "../helpers";

const FAKE = join(REPO_ROOT, "tests/fixtures/fake-claude.ts");
chmodSync(FAKE, 0o755);

async function usac(args: string[], home: string) {
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/daemon/src/cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, USAC_HOME: home, USAC_CLAUDE_BIN: FAKE, USAC_SANDBOX: "0" },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out + err, code };
}

describe("Phase 0: CLI", () => {
  test("A11: usac run wartet auf Freigabe H1, approve + resume fuehren zum Ergebnis", async () => {
    const project = setupProject();
    const home = tempHome();

    const run = await usac(["run", "bugfix", "-t", "Rotation ignoriert Cooldowns", "--project", project], home);
    expect(run.out).toContain("awaiting_approval");
    const id = run.out.match(/Auftrag (wi_\w+)/)![1]!;

    const status = await usac(["status", id], home);
    const approvalId = status.out.match(/Freigabe (\d+) \(h1\)/)![1]!;

    const approve = await usac(["approve", approvalId], home);
    expect(approve.out).toContain("erteilt");

    const resume = await usac(["resume", id], home);
    expect(resume.out).toContain(": done");
    expect(git(project, "log", "--format=%s", `usac/${id}`, "-2")).toBe(
      'fix: Rotation ignoriert Cooldowns\ntest: Abnahmetest fuer "Rotation ignoriert Cooldowns"',
    );

    const events = await usac(["events", id], home);
    for (const t of ["acceptance.red", "approval.granted", "test.locked", "acceptance.green", "review.approved", "workitem.done"]) {
      expect(events.out).toContain(t);
    }
    // Modelle laut Routing: Abnahmetest Opus, Implementierung Sonnet, Review Opus.
    expect(events.out).toMatch(/run\.started\s+role:test-engineer\s+\{"role":"test-engineer","model":"opus"\}/);
    expect(events.out).toMatch(/run\.started\s+role:implementer\s+\{"role":"implementer","model":"sonnet"\}/);
  }, 120_000);

  test("--auto h2 wird abgelehnt, H2 erteilt immer ein Mensch", async () => {
    const project = setupProject();
    const home = tempHome();
    for (const auto of ["h2", "h1,h2"]) {
      const run = await usac(["run", "feature", "-t", "x", "--project", project, "--auto", auto], home);
      expect(run.code).not.toBe(0);
      expect(run.out).toContain("--auto h2 ist nicht erlaubt");
      expect(run.out).not.toContain("angelegt");
    }
    // Es wurde kein Auftrag angelegt, also auch keine Freigabe erteilt.
    const status = await usac(["status"], home);
    expect(status.out).not.toMatch(/wi_\w+/);
  }, 60_000);

  test("usac ui startet den Server auf 127.0.0.1 und gibt die URL aus", async () => {
    const home = tempHome();
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/daemon/src/cli.ts"), "ui", "--port", "0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, USAC_HOME: home },
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      let url: string | undefined;
      const deadline = Date.now() + 20_000;
      while (!url && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
        url = out.match(/http:\/\/127\.0\.0\.1:\d+\/?/)?.[0];
      }
      expect(url).toBeDefined();
      const res = await fetch(new URL("/api/inbox", url!));
      expect(res.status).toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});
