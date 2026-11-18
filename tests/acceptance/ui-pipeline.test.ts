import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { openStore, type Store } from "../../packages/daemon/src/store";
import { pipelineData, pipelineHtml, pipelineSvg, type PipelineNode } from "../../packages/ui/src/views/pipeline";
import { esc, page } from "../../packages/ui/src/html";

const ROOT = resolve(import.meta.dir, "../..");

function ev(store: Store, traceId: string, type: string, data: Record<string, unknown> = {}) {
  return store.append({ traceId, spanId: "s", project: "p", type, actor: "orchestrator", data } as never);
}

function item(store: Store, id: string, type = "bugfix", title = "T") {
  // Projektpfad ohne Profil: die Ansicht darf daran nicht scheitern.
  store.createWorkItem({ id, projectPath: "/gibt/es/nicht", type, title, description: "d", size: "S" } as never);
}

function node(nodes: PipelineNode[], name: string): PipelineNode {
  const n = nodes.find((x) => x.name === name);
  if (!n) throw new Error(`Knoten ${name} fehlt`);
  return n;
}

describe("Pipeline-Graph", () => {
  test("Status je Phase", () => {
    const store = openStore(":memory:");
    item(store, "w1");
    for (const name of ["setup", "acceptance", "approve_h1"]) ev(store, "w1", "phase.entered", { name });
    store.createApproval("w1", "h1", {});
    store.updateWorkItem("w1", { status: "awaiting_approval" });
    const data = pipelineData(store, ROOT, "w1")!;
    expect(data.workItemId).toBe("w1");
    expect(data.workflow).toBe("bugfix");
    expect(data.nodes.map((n) => n.name)).toEqual(["setup", "acceptance", "approve_h1", "lock", "implement", "review", "integrate"]);
    expect(node(data.nodes, "setup").status).toBe("done");
    expect(node(data.nodes, "acceptance").status).toBe("done");
    expect(node(data.nodes, "approve_h1").status).toBe("current");
    expect(node(data.nodes, "implement").status).toBe("pending");
    expect(node(data.nodes, "acceptance").role).toBe("test-engineer");
  });

  test("übersprungene Phase", () => {
    const store = openStore(":memory:");
    item(store, "w2", "feature");
    for (const name of ["setup", "spec", "approve_spec"]) ev(store, "w2", "phase.entered", { name });
    ev(store, "w2", "phase.skipped", { name: "design", reason: "size" });
    ev(store, "w2", "phase.entered", { name: "plan" });
    const nodes = pipelineData(store, ROOT, "w2")!.nodes;
    expect(node(nodes, "design").status).toBe("skipped");
    expect(node(nodes, "approve_spec").status).toBe("done");
    expect(node(nodes, "plan").status).toBe("current");
  });

  test("Versuche und Modell", () => {
    const store = openStore(":memory:");
    item(store, "w3");
    for (const name of ["setup", "acceptance", "approve_h1", "lock", "implement"]) ev(store, "w3", "phase.entered", { name });
    ev(store, "w3", "run.started", { role: "implementer", model: "sonnet" });
    ev(store, "w3", "run.finished", { role: "implementer", model: "sonnet", ok: false });
    ev(store, "w3", "run.started", { role: "implementer", model: "opus" });
    const impl = node(pipelineData(store, ROOT, "w3")!.nodes, "implement");
    expect(impl.attempts).toBe(2);
    expect(impl.model).toBe("opus");
    expect(node(pipelineData(store, ROOT, "w3")!.nodes, "review").attempts).toBe(0);
  });

  test("Eskalation markiert die Phase rot", () => {
    const store = openStore(":memory:");
    item(store, "w4");
    for (const name of ["setup", "acceptance", "approve_h1", "lock", "implement"]) ev(store, "w4", "phase.entered", { name });
    ev(store, "w4", "workitem.escalated", { phase: "implement", reason: "max_attempts" });
    store.updateWorkItem("w4", { status: "escalated" });
    const nodes = pipelineData(store, ROOT, "w4")!.nodes;
    expect(node(nodes, "implement").status).toBe("failed");
    expect(node(nodes, "lock").status).toBe("done");
    expect(node(nodes, "review").status).toBe("pending");
    const svg = pipelineSvg(nodes);
    expect(svg).toContain("st-failed");
    // Status steht auch als Text im Graphen, nicht nur als Farbe.
    expect(svg).toContain("fehlgeschlagen");
  });

  test("SVG: Knoten waagrecht, Umbruch nach 8", () => {
    const nodes: PipelineNode[] = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, status: "pending", attempts: 0 }));
    const svg = pipelineSvg(nodes);
    const ys = [...svg.matchAll(/<g class="node st-pending" transform="translate\((\d+),(\d+)\)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(ys.length).toBe(10);
    expect(new Set(ys.slice(0, 8).map((p) => p[1])).size).toBe(1);
    expect(ys[8]![1]).toBeGreaterThan(ys[7]![1]!);
    expect(ys[8]![0]).toBe(ys[0]![0]);
    expect(ys[1]![0]).toBeGreaterThan(ys[0]![0]!);
  });

  test("Escaping", () => {
    const store = openStore(":memory:");
    item(store, "w5", "bugfix", "<script>alert(1)</script>");
    const html = pipelineHtml(store, ROOT, "w5");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("Seitenrahmen mit Navigation, Manifest, palette.js und Token", () => {
    const html = page("Titel <x>", "<p>Inhalt</p>", { token: `t"1` });
    expect(html).toContain("<title>Titel &lt;x&gt;</title>");
    expect(html).toContain(`href="/manifest.webmanifest"`);
    expect(html).toContain(`src="/palette.js"`);
    expect(html).toContain(`<meta name="usac-token" content="t&quot;1">`);
    expect(html).toContain(`href="/wall"`);
    expect(html).toContain("<p>Inhalt</p>");
  });

  test("unbekannter Auftrag", () => {
    const store = openStore(":memory:");
    expect(pipelineData(store, ROOT, "fehlt")).toBeNull();
  });
});
