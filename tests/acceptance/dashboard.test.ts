/**
 * Abnahme Dashboard: Die Seite /dashboard zeigt Stories, Schritte und Datenbank-Tabellen,
 * /api/dashboard liefert dieselben Daten als JSON, optional gefiltert nach Story.
 */
import { describe, expect, test } from "bun:test";
import { REPO_ROOT, tempHome } from "../helpers";
import { createApp } from "../../packages/ui/src/server";
import { openStore } from "../../packages/daemon/src/store";

function seeded() {
  const store = openStore(":memory:");
  store.createWorkItem({ id: "wi_1", projectPath: "C:/p", type: "feature", title: "Story Alpha", description: "d", size: "small" });
  store.createWorkItem({ id: "wi_2", projectPath: "C:/p", type: "bugfix", title: "Story Beta", description: "d", size: "small" });
  store.recordStep({
    workItemId: "wi_1",
    role: "implementer",
    model: "sonnet",
    ok: true,
    files: ["src/rotation.lua"],
    startedAt: "2026-11-19T10:00:00.000Z",
    endedAt: "2026-11-19T10:01:00.000Z",
  });
  return store;
}

describe("Dashboard (Abnahme)", () => {
  test("/api/dashboard liefert Stories, Schritte und Tabellenzaehler", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const res = await app.request("/api/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stories: { id: string; title: string }[];
      steps: { role: string; files: string[] }[];
      tables: Record<string, number>;
    };
    expect(body.stories.map((s) => s.title)).toEqual(expect.arrayContaining(["Story Alpha", "Story Beta"]));
    expect(body.steps.map((s) => s.role)).toEqual(["implementer"]);
    expect(body.steps[0]!.files).toEqual(["src/rotation.lua"]);
    expect(Object.keys(body.tables)).toEqual(expect.arrayContaining(["events", "steps", "gate_results", "workitems"]));
    expect(body.tables.steps).toBe(1);
  });

  test("/api/dashboard?story=<id> filtert die Schritte auf eine Story", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?story=wi_2")).json()) as { steps: unknown[] };
    expect(body.steps).toEqual([]);
  });

  test("/dashboard zeigt Seitenleiste, Story, Schritt-Dateien und den Live-Status", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const res = await app.request("/dashboard?story=wi_1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Story Alpha");
    expect(html).toContain("src/rotation.lua");
    expect(html).toContain("Datenbank");
    expect(html).toContain("CONNECTED");
  });
});
