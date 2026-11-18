import { describe, expect, test } from "bun:test";
import { openStore } from "../../packages/daemon/src/store";
import { createApp, startServer } from "../../packages/ui/src/server";

function ev(store: ReturnType<typeof openStore>, traceId: string, type: string, data: Record<string, unknown> = {}) {
  return store.append({ traceId, spanId: "s", project: "p", type, actor: "orchestrator", data } as never);
}

describe("UI v1", () => {
  test("Inbox zeigt offene Freigaben", async () => {
    const store = openStore(":memory:");
    store.createWorkItem({ id: "w1", projectPath: "/p", type: "bugfix", title: "T", description: "d", size: "S" } as never);
    store.createApproval("w1", "h1", { note: "bitte pruefen" });
    const done = store.createApproval("w1", "h2", {});
    store.resolveApproval(done.id, true);
    const res = await createApp(store).request("/api/inbox");
    const body = (await res.json()) as { approvals: { workItemId: string; kind: string }[] };
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0]!.kind).toBe("h1");
  });

  test("Run-Detail zeigt das Event-Log", async () => {
    const store = openStore(":memory:");
    ev(store, "r1", "workitem.created");
    ev(store, "other", "workitem.created");
    ev(store, "r1", "run.finished", { role: "dev" });
    ev(store, "r1", "merged");
    const res = await createApp(store).request("/api/runs/r1");
    const body = (await res.json()) as { events: { type: string }[] };
    expect(body.events.map((e) => e.type)).toEqual(["workitem.created", "run.finished", "merged"]);
  });

  test("Kontext-Warnung erscheint", async () => {
    const store = openStore(":memory:");
    ev(store, "r2", "budget.exceeded", { role: "dev", context: 190000, limit: 180000 });
    const app = createApp(store);
    const body = (await (await app.request("/api/runs/r2")).json()) as { warnings: { type: string }[]; events: unknown[] };
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]!.type).toBe("budget.exceeded");
    const html = await (await app.request("/runs/r2")).text();
    expect(html).toContain("budget.exceeded");
  });

  test("Agent-Wand liefert Work-Items aus dem Store", async () => {
    const store = openStore(":memory:");
    store.createWorkItem({ id: "w9", projectPath: "/p", type: "bugfix", title: "Wand", description: "d", size: "S" } as never);
    const body = (await (await createApp(store).request("/api/wall")).json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toContain("w9");
  });

  test("Server bindet nur an 127.0.0.1", () => {
    const store = openStore(":memory:");
    const server = startServer(store, { port: 0 });
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });
});
