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
    tokens: { input: 1200, output: 300 },
  });
  store.recordStep({
    workItemId: "wi_1",
    role: "analyst",
    model: "opus",
    ok: true,
    files: [],
    startedAt: "2026-11-19T09:50:00.000Z",
    endedAt: "2026-11-19T09:52:00.000Z",
    tokens: { input: 5000, output: 900 },
  });
  store.saveSlices(
    "wi_1",
    [
      { id: "S1", title: "Cooldown-Filter", criteria: ["AC-1"], files: ["src/rotation.lua"], depends_on: [] },
      { id: "S2", title: "Anzeige", criteria: ["AC-2"], files: ["src/menu.lua"], depends_on: ["S1"] },
    ],
    ["S1", "S2"],
  );
  store.setSliceStatus("wi_1", "S1", "green");
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
    expect(body.steps.map((s) => s.role)).toEqual(["implementer", "analyst"]);
    expect(body.steps[0]!.files).toEqual(["src/rotation.lua"]);
    expect(Object.keys(body.tables)).toEqual(expect.arrayContaining(["events", "steps", "gate_results", "workitems"]));
    expect(body.tables.steps).toBe(2);
  });

  test("/api/dashboard?story=<id> liefert die Slices mit Status in Reihenfolge", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?story=wi_1")).json()) as {
      slices: { id: string; title: string; status: string; dependsOn: string[] }[];
    };
    expect(body.slices.map((s) => [s.id, s.status])).toEqual([
      ["S1", "green"],
      ["S2", "pending"],
    ]);
    expect(body.slices[1]!.dependsOn).toEqual(["S1"]);
  });

  test("/api/dashboard?story=<id> filtert die Schritte auf eine Story", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?story=wi_2")).json()) as { steps: unknown[] };
    expect(body.steps).toEqual([]);
  });

  test("/api/dashboard?view=tokens liefert Summen und Verlauf je Modell", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?view=tokens")).json()) as {
      totals: { input: number; output: number; total: number };
      byModel: { model: string; total: number }[];
      series: { at: string; total: number }[];
    };
    expect(body.totals).toEqual({ input: 6200, output: 1200, total: 7400 });
    expect(body.byModel.find((m) => m.model === "opus")!.total).toBe(5900);
    expect(body.series.length).toBe(2);
    expect(body.series[1]!.total).toBeGreaterThan(body.series[0]!.total);
  });

  test("/api/dashboard?view=sessions liefert alle Schritte mit Story-Titel", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?view=sessions")).json()) as {
      sessions: { story: string; role: string; model: string }[];
    };
    expect(body.sessions.map((s) => s.role)).toEqual(["implementer", "analyst"]);
    expect(body.sessions[0]!.story).toBe("Story Alpha");
  });

  test("/api/dashboard?view=diagnose meldet die Pruefungen der Datenbank", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const body = (await (await app.request("/api/dashboard?view=diagnose")).json()) as {
      checks: { name: string; ok: boolean }[];
    };
    const byName = new Map(body.checks.map((c) => [c.name, c.ok]));
    expect(byName.get("Datenbank erreichbar")).toBe(true);
    expect(byName.get("Schritte gespeichert")).toBe(true);
    expect(byName.get("Tokens erfasst")).toBe(true);
    expect(body.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["Datenbank erreichbar", "Schritte gespeichert"]));
  });

  test("/dashboard?view=tokens zeigt Diagramm und Modell-Verteilung", async () => {
    const store = seeded();
    const app = createApp(store, { home: tempHome(), pluginRoot: REPO_ROOT });
    const html = await (await app.request("/dashboard?view=tokens")).text();
    expect(html).toContain("Token-Metriken");
    expect(html).toContain("<svg");
    expect(html).toContain("opus");
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
