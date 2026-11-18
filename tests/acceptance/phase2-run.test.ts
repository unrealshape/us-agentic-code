/**
 * Abnahme Phase 2, Task 7: Hooks, GateGuard, Doppel-Review, Slots und Daemon im echten Lauf.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { createOrchestrator } from "../../packages/daemon/src/orchestrator";
import { appendHookLog } from "../../packages/daemon/src/hook-log";
import { createScheduler, ensureSlotSchema, tryAcquireSlot } from "../../packages/daemon/src/scheduler";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";

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

const reviewerOk: Handler = async () => ({ output: { verdict: "approve", summary: "ok", findings: [], claims: [] } });

function setup(handlers: Record<string, Handler> = {}, auto: string[] = ["h1"]) {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner({ "test-engineer": testEngineerOk, implementer: implementerOk, "code-reviewer": reviewerOk, ...handlers });
  const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto }, graphify: false });
  return { project, home, store, runner, orch };
}

describe("Phase 2: Verdrahtung im Orchestrator", () => {
  test("Protector-Meldung landet in der Inbox", async () => {
    const reporting: Handler = async (spec, n) => {
      appendHookLog(spec.env!.USAC_HOOK_LOG!, {
        ts: new Date().toISOString(),
        hook: "protector",
        mode: "melden",
        action: "reported",
        rule: "secrets",
        tool: "Bash",
        target: "cat .env",
      });
      return implementerOk(spec, n);
    };
    const { project, store, orch } = setup({ implementer: reporting });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    const r = await orch.run(wi.id);
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    const ev = store.events({ traceId: wi.id }).find((e) => e.type === "protector.reported");
    expect(ev).toBeDefined();
    expect(ev!.data).toMatchObject({ rule: "secrets", tool: "Bash", target: "cat .env" });
    const pending = store.pendingApprovals().filter((a) => a.workItemId === wi.id);
    expect(pending.map((a) => a.kind)).toEqual(["protector"]);
  }, 60_000);

  test("GateGuard nur für den Implementer", async () => {
    const { project, runner, orch } = setup();
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    expect((await orch.run(wi.id)).status).toBe("done");
    const roles = new Set(runner.calls.map((c) => c.role));
    expect(roles.has("implementer")).toBe(true);
    for (const c of runner.calls) {
      expect(c.env?.USAC_GATEGUARD === "1").toBe(c.role === "implementer");
      expect(c.env?.USAC_WORK_ITEM).toBe(wi.id);
      expect(c.env?.USAC_PROTECTOR_MODE).toBe("blockieren");
      expect(c.env?.USAC_HOOK_LOG).toMatch(/hooklogs[\\/]run_[0-9a-f]+\.jsonl$/);
      // Gate-Profil lua erlaubt luarocks.org.
      expect(c.networkAllow).toEqual(["luarocks.org"]);
    }
  }, 60_000);

  test("Doppel-Review im echten Lauf", async () => {
    const { project, runner, orch } = setup();
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x", size: "large" });
    const r = await orch.run(wi.id);
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("done");
    expect(runner.calls.filter((c) => c.role === "code-reviewer").length).toBe(2);
    expect(runner.calls.some((c) => c.model === "fable")).toBe(false);
  }, 60_000);

  test("volle Slots", async () => {
    const { project, store, orch } = setup();
    ensureSlotSchema(store);
    for (let i = 0; i < 3; i++) {
      const w = await orch.submit({ projectPath: project, type: "bugfix", title: `halte ${i}`, description: "x" });
      expect(tryAcquireSlot(store, w.id, 3, Date.now())).toBe(true);
    }
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "vierter", description: "x" });
    const r = await orch.run(wi.id);
    expect(r.status).toBe("queued");
    expect(store.getWorkItem(wi.id)!.status).toBe("queued");
    expect(store.events({ traceId: wi.id }).map((e) => e.type)).toContain("slot.wait");
  }, 60_000);

  test("Freigabe reiht wartenden Auftrag wieder ein, der Scheduler setzt ihn fort", async () => {
    const { project, store, orch } = setup({}, []);
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    const h1 = store.pendingApprovals().find((a) => a.workItemId === wi.id && a.kind === "h1")!;
    orch.approve(h1.id, true);
    expect(store.getWorkItem(wi.id)!.status).toBe("queued");
    const sched = createScheduler({ store, run: (id) => orch.run(id, { slotHeld: true }) });
    expect(await sched.tick()).toEqual([wi.id]);
    await sched.idle();
    expect(store.getWorkItem(wi.id)!.status).toBe("done");
  }, 60_000);

  test("CLI daemon startet", async () => {
    const home = tempHome();
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/daemon/src/cli.ts"), "daemon", "--parallel", "3"], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, USAC_HOME: home, USAC_SANDBOX: "0" },
    });
    const reader = proc.stdout.getReader();
    let out = "";
    const deadline = Date.now() + 20_000;
    while (!out.includes("Daemon läuft") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("Daemon läuft");
    proc.kill("SIGINT");
    const code = await proc.exited;
    // Unter Windows stellt Bun (1.4.4) SIGINT nicht zu, sondern beendet den Prozess (Exit 130, signalCode SIGINT);
    // der Handler laeuft dort nie. Exit 0 ist daher nur unter Linux/WSL2 pruefbar, wie die Sandbox-Tests.
    if (process.platform !== "win32") expect(code).toBe(0);
    else expect(proc.signalCode ?? "SIGINT").toBe("SIGINT");
  }, 30_000);
});
