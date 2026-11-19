/**
 * Abnahme Phase 5, Task 10: Verdrahtung von UI-Server, Orchestrator und CLI.
 * Routen, Host-Schutz, Phasenereignisse, Freigabe-Wartezeit, Herabstufung ueber die Freigabe.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION, REPO_ROOT, setupProject, tempHome } from "../helpers";
import { openStore } from "../../packages/daemon/src/store";
import { createOrchestrator, suggestRoutingApprovals } from "../../packages/daemon/src/orchestrator";
import { computeMetrics } from "../../packages/daemon/src/metrics";
import { loadRouting } from "../../packages/daemon/src/routing";
import { loadWorkflow } from "../../packages/daemon/src/workflow";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { createApp, startServer } from "../../packages/ui/src/server";
import { pipelineData } from "../../packages/ui/src/views/pipeline";

const G = { token: "e".repeat(64), port: 7777 };

const ACC_PATH = "spec/acceptance/cooldown_spec.lua";

/** Wie in phase2-run.test.ts: echte Dateien, damit der Bugfix-Lauf bis integrate durchlaeuft. */
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

function fixture() {
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const project = setupProject();
  return { home, store, project };
}

describe("Phase 5: Verdrahtung", () => {
  test("alle Routen antworten mit 200 und passendem Content-Type", async () => {
    const { home, store } = fixture();
    store.createWorkItem({ id: "w1", projectPath: "/p/proj", type: "bugfix", title: "T", description: "d", size: "S" } as never);
    const app = createApp(store, { home, pluginRoot: REPO_ROOT, guard: G });
    const cases: [string, RegExp][] = [
      ["/runs/w1/pipeline", /text\/html/],
      ["/runs/w1/review", /text\/html/],
      ["/knowledge", /text\/html/],
      ["/metrics", /text\/html/],
      ["/api/commands", /application\/json/],
      ["/manifest.webmanifest", /manifest|json/],
      ["/sw.js", /javascript/],
      ["/palette.js", /javascript/],
      ["/notify.js", /javascript/],
      ["/icon.svg", /svg/],
    ];
    for (const [path, type] of cases) {
      const res = await app.request(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect({ path, ct: res.headers.get("content-type") ?? "" }).toEqual({ path, ct: expect.stringMatching(type) });
    }
  });

  test("fremder Host wird auf allen Routen mit 403 abgewiesen", async () => {
    const { home, store } = fixture();
    const server = startServer(store, { port: 0, home, pluginRoot: REPO_ROOT });
    try {
      for (const path of ["/", "/metrics", "/knowledge", "/api/commands", "/manifest.webmanifest"]) {
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Host: "evil.test" } });
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
      const ok = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(ok.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("CSRF: fremde Origin oder fehlender Token aendert keine Freigabe", async () => {
    const { home, store } = fixture();
    store.createWorkItem({ id: "w5", projectPath: "/p/proj", type: "bugfix", title: "T", description: "d", size: "S" } as never);
    const a = store.createApproval("w5", "h1", {});
    const server = startServer(store, { port: 0, home, pluginRoot: REPO_ROOT });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const body = JSON.stringify({ granted: true });
      const evil = await fetch(`${base}/api/approvals/${a.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", Host: "evil.test", Origin: "http://evil.test" },
        body,
      });
      expect(evil.status).toBe(403);
      const noToken = await fetch(`${base}/api/approvals/${a.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: base },
        body,
      });
      expect(noToken.status).toBe(403);
      expect(store.getApproval(a.id)!.status).toBe("pending");
    } finally {
      server.stop(true);
    }
  });

  test("jeder Serverstart erzeugt einen neuen Token", async () => {
    const { home, store } = fixture();
    const tokenOf = async (port: number) => {
      const html = await (await fetch(`http://127.0.0.1:${port}/knowledge`)).text();
      return /name="usac-token" content="([0-9a-f]+)"/.exec(html)?.[1];
    };
    const s1 = startServer(store, { port: 0, home, pluginRoot: REPO_ROOT });
    const s2 = startServer(store, { port: 0, home, pluginRoot: REPO_ROOT });
    try {
      const t1 = await tokenOf(s1.port!);
      const t2 = await tokenOf(s2.port!);
      expect(t1).toBeDefined();
      expect(t1).not.toBe(t2);
    } finally {
      s1.stop(true);
      s2.stop(true);
    }
  });

  test("Phasenwechsel sind als phase.entered sichtbar und in Workflow-Reihenfolge", async () => {
    const { home, store, project } = fixture();
    const runner = new ScriptedRunner({
      "test-engineer": testEngineerOk,
      implementer: implementerOk,
      "code-reviewer": reviewerOk,
    });
    const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: [] }, graphify: false });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    // Bis zur Freigabe H1: setup, acceptance, approve_h1. Das Format-Gate der Fixture ist nicht Gegenstand dieses Tests.
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    const wf = loadWorkflow(join(REPO_ROOT, "workflows", "bugfix.yaml"));
    const names = wf.phases.map((p) => p.name);
    const entered = () => store.events({ traceId: wi.id, type: "phase.entered" }).map((e) => (e.data as { name: string }).name);
    const before = entered();
    expect(before).toEqual(names.slice(0, names.indexOf("approve_h1") + 1).filter((n) => !store.events({ traceId: wi.id, type: "phase.skipped" }).some((e) => (e.data as { name: string }).name === n)));
    // Nach der Freigabe geht der Lauf weiter; die Phase, in der er wartete, wird nicht ein zweites Mal gemeldet.
    orch.approve(store.pendingApprovals().find((a) => a.workItemId === wi.id)!.id, true);
    await orch.run(wi.id);
    const after = entered();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toBe("lock");
    expect(after.filter((n) => n === "approve_h1").length).toBe(1);
    const nodes = pipelineData(store, REPO_ROOT, wi.id)!.nodes;
    expect(nodes.find((n) => n.name === "approve_h1")?.status).toBe("done");
  }, 60_000);

  test("Wartezeit wird messbar: approve schreibt approval.resolved, computeMetrics liefert sie", async () => {
    const { home, store, project } = fixture();
    const runner = new ScriptedRunner({
      "test-engineer": testEngineerOk,
      implementer: implementerOk,
      "code-reviewer": reviewerOk,
    });
    const orch = createOrchestrator({ store, runner, pluginRoot: REPO_ROOT, home, approvals: { auto: [] }, graphify: false });
    const wi = await orch.submit({ projectPath: project, type: "bugfix", title: "Cooldown", description: "x" });
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    const pending = store.pendingApprovals().find((a) => a.workItemId === wi.id)!;
    orch.approve(pending.id, true);
    const resolved = store.events({ traceId: wi.id }).find((e) => e.type === "approval.resolved");
    expect(resolved!.data).toMatchObject({ approval_id: pending.id, granted: true, by: "cli" });
    const m = computeMetrics(store.events(), { sprintStart: new Date(0), sprintDays: 3650, now: new Date() });
    expect(m.approvalWait.length).toBeGreaterThan(0);
  }, 60_000);

  test("Herabstufung ueber Freigabe: Vorschlag, Erteilung setzt implementer auf haiku, Duplikate entfallen", () => {
    const { home, store, project } = fixture();
    const orch = createOrchestrator({ store, runner: new ScriptedRunner({}), pluginRoot: REPO_ROOT, home, graphify: false });
    store.createWorkItem({ id: "w7", projectPath: project, type: "bugfix", title: "T", description: "d", size: "S" } as never);
    for (let i = 0; i < 25; i++) {
      store.append({
        ts: "2026-11-03T10:00:00Z",
        traceId: `T${i}`,
        spanId: `s${i}`,
        project: "p",
        type: "run.finished",
        actor: "orchestrator",
        data: { role: "implementer", model: "sonnet", ok: true, turns: 1, tokens: { input: 10, output: 5 } },
      });
    }
    const overridePath = join(home, "routing.override.yaml");
    const now = new Date("2026-11-19T12:00:00Z");
    const created = suggestRoutingApprovals(store, { pluginRoot: REPO_ROOT, home, now });
    expect(created.map((c) => c.key)).toEqual(["implementer"]);
    expect(suggestRoutingApprovals(store, { pluginRoot: REPO_ROOT, home, now }).length).toBe(0);
    const pendingRouting = store.pendingApprovals().filter((a) => a.kind === "routing_change");
    expect(pendingRouting.length).toBe(1);
    expect(loadRouting(REPO_ROOT, overridePath).defaults.implementer).toBe("sonnet");
    orch.approve(pendingRouting[0]!.id, true);
    expect(loadRouting(REPO_ROOT, overridePath).defaults.implementer).toBe("haiku");
  });

  test("Herabstufung ueber die UI-Freigabe wird angewendet, Anfrage ohne Token bleibt ohne Wirkung", async () => {
    const { home, store, project } = fixture();
    createOrchestrator({ store, runner: new ScriptedRunner({}), pluginRoot: REPO_ROOT, home, graphify: false });
    store.createWorkItem({ id: "w8", projectPath: project, type: "bugfix", title: "T", description: "d", size: "S" } as never);
    for (let i = 0; i < 25; i++) {
      store.append({
        ts: "2026-11-03T10:00:00Z",
        traceId: `U${i}`,
        spanId: `u${i}`,
        project: "p",
        type: "run.finished",
        actor: "orchestrator",
        data: { role: "implementer", model: "sonnet", ok: true, turns: 1, tokens: { input: 10, output: 5 } },
      });
    }
    const overridePath = join(home, "routing.override.yaml");
    suggestRoutingApprovals(store, { pluginRoot: REPO_ROOT, home, now: new Date("2026-11-19T12:00:00Z") });
    const a = store.pendingApprovals().find((x) => x.kind === "routing_change")!;
    const app = createApp(store, { home, pluginRoot: REPO_ROOT, guard: G });
    const headers = { "content-type": "application/json", "X-Usac-Token": G.token, Origin: "http://127.0.0.1:7777", Host: "127.0.0.1:7777" };
    const body = JSON.stringify({ granted: true });
    const noToken = await app.request(`/api/approvals/${a.id}`, { method: "POST", headers: { ...headers, "X-Usac-Token": "falsch" }, body });
    expect(noToken.status).toBe(403);
    expect(loadRouting(REPO_ROOT, overridePath).defaults.implementer).toBe("sonnet");
    const ok = await app.request(`/api/approvals/${a.id}`, { method: "POST", headers, body });
    expect(ok.status).toBe(200);
    expect(loadRouting(REPO_ROOT, overridePath).defaults.implementer).toBe("haiku");
    expect(store.events({ traceId: "routing", type: "approval.resolved" }).map((e) => e.data)).toEqual([{ approval_id: a.id, granted: true, by: "ui" }]);
  });

  test("UI v1 ohne Verdrahtung: Inbox liefert JSON", async () => {
    const store = openStore(":memory:");
    const res = await createApp(store).request("/api/inbox");
    expect(res.status).toBe(200);
  });
});
