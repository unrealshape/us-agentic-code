import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../helpers";
import { openStore, type Store } from "../../packages/daemon/src/store";
import { loadRouting } from "../../packages/daemon/src/routing";
import { metricsHtml } from "../../packages/ui/src/views/metrics";
import { commandsData } from "../../packages/ui/src/views/palette";

const OPTS = { sprintStart: new Date("2026-11-02T00:00:00Z"), sprintDays: 7, now: new Date("2026-11-15T12:00:00Z") };
const ROUTING = loadRouting(REPO_ROOT);

let spanSeq = 0;
function run(store: Store, traceId: string, role: string, model: string, ok: boolean, ts: string) {
  const spanId = `${traceId}-${role}-${spanSeq++}`;
  store.append({ ts, traceId, spanId, project: "p", type: "run.started", actor: "orchestrator", data: { role, model } });
  store.append({
    ts,
    traceId,
    spanId,
    project: "p",
    type: "run.finished",
    actor: "orchestrator",
    data: { role, model, ok, turns: 1, tokens: { input: 10, output: 5 } },
  });
}

describe("Metrik-Ansicht und Command-Palette", () => {
  test("Metrik-Seite zeigt Velocity als Grafik und Tabelle", () => {
    const store = openStore(":memory:");
    store.append({ ts: "2026-11-03T10:00:00Z", traceId: "A", spanId: "A", project: "p", type: "workitem.done", actor: "orchestrator", data: {} });
    store.append({ ts: "2026-11-04T10:00:00Z", traceId: "B", spanId: "B", project: "p", type: "workitem.done", actor: "orchestrator", data: {} });
    const html = metricsHtml(store, ROUTING, OPTS);
    expect(html).toContain("<svg");
    expect(html).toMatch(/<tr>\s*<td>[^<]*<\/td>\s*<td>2<\/td>/);
  });

  test("Vorschlag erscheint", () => {
    const store = openStore(":memory:");
    for (let i = 0; i < 25; i++) run(store, `T${i}`, "implementer", "sonnet", true, "2026-11-03T10:00:00Z");
    const html = metricsHtml(store, ROUTING, OPTS);
    expect(html).toContain("sonnet → haiku");
  });

  test("Palette-Befehle", () => {
    const store = openStore(":memory:");
    store.createWorkItem({ id: "w1", projectPath: "/p/proj", type: "bugfix", title: "T", description: "d", size: "S" } as never);
    run(store, "w1", "implementer", "sonnet", true, "2026-11-03T10:00:00Z");
    store.createApproval("w1", "h1", {});
    const cmds = commandsData(store);
    expect(cmds.map((c) => c.href)).toContain("/runs/w1/review");
    expect(cmds.some((c) => c.action === "approve")).toBe(false);
  });

  test("palette.js behandelt Meta+K und Ctrl+K und ist ein Dialog", () => {
    const js = readFileSync(join(REPO_ROOT, "packages/ui/public/palette.js"), "utf8");
    expect(js).toContain("metaKey");
    expect(js).toContain("ctrlKey");
    expect(js).toMatch(/["']k["']/);
    expect(js).toContain("aria-modal");
  });
});
