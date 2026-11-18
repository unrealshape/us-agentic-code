import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../packages/ui/src/server";

type Hono = ReturnType<typeof createApp>;
import { openStore } from "../../packages/daemon/src/store";
import { addEntry, memoryUid, openMemory, search } from "../../packages/daemon/src/memory";
import { activateInstinct, getInstinct, proposeInstinct, retireInstinct } from "../../packages/daemon/src/instincts";
import type { Guard } from "../../packages/ui/src/actions";
import { knowledgeData, knowledgeHtml, registerKnowledge } from "../../packages/ui/src/views/knowledge";
import { registerKnowledgeActions } from "../../packages/ui/src/knowledge-actions";

const G: Guard = { token: "c".repeat(64), port: 7777 };
const OK_HEADERS = { "X-Usac-Token": G.token, Origin: "http://127.0.0.1:7777", Host: "127.0.0.1:7777" };
const COOLDOWN = "Cooldown in Sekunden";
const QUOTE = "local cooldown_seconds = 30";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fixture-Projekt mit Lua-Quelle, CLAUDE.md und einem ADR. */
function project(): string {
  const dir = tmp("usac-knowledge-proj-");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "rotation.lua"), `-- Rotation\n${QUOTE}\nreturn cooldown_seconds\n`);
  writeFileSync(
    join(dir, "CLAUDE.md"),
    "# Projekt\n\n## Regeln\n\n- Immer Tests vor dem Commit ausfuehren.\n- Nie direkt auf main pushen.\n\n## Tests\n\n- Busted fuer Lua-Tests nutzen.\n",
  );
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "adr", "0001-x.md"),
    "# ADR 0001: Lua als Sprache\n\nStatus: Angenommen\n\n## Offene Fragen\n\n- Welche Lua-Version im CI?\n",
  );
  return dir;
}

function setup() {
  const projectPath = project();
  const home = tmp("usac-knowledge-home-");
  const store = openStore(":memory:");
  store.createWorkItem({ id: "w1", projectPath, type: "bugfix", title: "T", description: "d", size: "S" } as never);
  const memory = openMemory(":memory:");
  const deps = { memory, store, projectPath, home };
  const app = createApp(store);
  registerKnowledge(app, deps, G);
  registerKnowledgeActions(app, deps, G);
  return { projectPath, home, store, memory, deps, app };
}

const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = OK_HEADERS) =>
  app.request(`http://127.0.0.1:7777${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("Wissens-Ansicht", () => {
  test("Suche zeigt Treffer mit Belegen", async () => {
    const { projectPath, memory, deps, app } = setup();
    addEntry(memory, { kind: "fact", text: COOLDOWN, evidence: [{ file: "src/rotation.lua", lines: "2", quote: QUOTE }] });
    addEntry(memory, { kind: "fact", text: "Rotation laeuft im Uhrzeigersinn", evidence: [{ file: "src/rotation.lua", lines: "1", quote: "-- Rotation" + "   x" }] });
    const uid = memoryUid("fact", COOLDOWN);
    const res = await post(app, `/api/memory/${uid}/verify`, { root: projectPath });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verified: boolean }).verified).toBe(true);
    expect(search(memory, "cooldown")[0]!.status).toBe("verified");

    const data = knowledgeData(deps, "cooldown");
    expect(data.entries.map((e) => e.text)).toEqual([COOLDOWN]);
    expect(data.entries[0]!.status).toBe("verified");
    // Ohne Suchbegriff: die neuesten Eintraege, neueste zuerst.
    expect(knowledgeData(deps).entries.map((e) => e.text)).toEqual(["Rotation laeuft im Uhrzeigersinn", COOLDOWN]);

    const html = knowledgeHtml(data, { query: "cooldown" });
    expect(html).toContain("src/rotation.lua:2");
    expect(html).toContain("verified");
    const viaRoute = await (await app.request("http://127.0.0.1:7777/knowledge?q=cooldown")).text();
    expect(viaRoute).toContain("src/rotation.lua:2");
    expect(viaRoute).not.toContain("Uhrzeigersinn");
    expect(viaRoute).toContain(`<meta name="usac-token" content="${G.token}">`);
  });

  test("Instincts nach Status", () => {
    const { memory, deps } = setup();
    const p = (text: string) => proposeInstinct(memory, { text, role: "implementer", event_ids: [1] } as never, () => true);
    p("Instinct-vorgeschlagen");
    activateInstinct(memory, p("Instinct-aktiv"));
    retireInstinct(memory, p("Instinct-stillgelegt"), "veraltet");
    const data = knowledgeData(deps);
    expect(data.instincts.map((i) => i.status).sort()).toEqual(["active", "proposed", "retired"]);
    const html = knowledgeHtml(data);
    const sections = ["proposed", "active", "retired"].map((s) => html.indexOf(`<section class="instincts-${s}">`));
    for (const s of sections) expect(s).toBeGreaterThan(-1);
    const at = (t: string) => html.indexOf(t);
    expect(at("Instinct-vorgeschlagen")).toBeGreaterThan(sections[0]!);
    expect(at("Instinct-vorgeschlagen")).toBeLessThan(sections[1]!);
    expect(at("Instinct-aktiv")).toBeGreaterThan(sections[1]!);
    expect(at("Instinct-aktiv")).toBeLessThan(sections[2]!);
    expect(at("Instinct-stillgelegt")).toBeGreaterThan(sections[2]!);
    expect(html).toContain("veraltet");
  });

  test("Verfassung und ADRs erscheinen", () => {
    const { deps } = setup();
    const data = knowledgeData(deps);
    expect(data.constitution).not.toBeNull();
    expect(data.adrs.map((a) => a.title)).toEqual(["Lua als Sprache"]);
    const html = knowledgeHtml(data);
    const core = data.constitution!.core[0]!;
    expect(html).toContain(core.id);
    expect(html).toContain("Immer Tests vor dem Commit ausfuehren.");
    for (const part of data.constitution!.parts) {
      expect(html).toContain(part.name);
      for (const r of part.rules) expect(html).toContain(r.id);
    }
    expect(html).toContain("Busted fuer Lua-Tests nutzen.");
    expect(html).toContain("Lua als Sprache");
    expect(html).toContain("angenommen");
    expect(html).toContain("Welche Lua-Version im CI?");
    // Ohne Projekt: keine Verfassung, keine ADRs.
    const none = knowledgeData({ memory: deps.memory, home: deps.home });
    expect(none.constitution).toBeNull();
    expect(none.adrs).toEqual([]);
  });

  test("Escaping", async () => {
    const { memory, deps, app } = setup();
    const evil = "<img src=x onerror=alert(1)>";
    addEntry(memory, { kind: "fact", text: evil, evidence: [{ file: `src/${evil}.lua`, lines: "1", quote: `"quote" ${evil}` }] });
    proposeInstinct(memory, { text: evil, role: "<b>rolle</b>", event_ids: [1] } as never, () => true);
    const html = knowledgeHtml(knowledgeData(deps), { query: `"><script>q</script>` });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>rolle");
    expect(html).not.toContain("<script>q");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const viaRoute = await (await app.request(`http://127.0.0.1:7777/knowledge?q=${encodeURIComponent("<img")}`)).text();
    expect(viaRoute).not.toContain("<img");
  });

  test("Stilllegen braucht Token", async () => {
    const { memory, app } = setup();
    const id = proposeInstinct(memory, { text: "Instinct X", role: "implementer", event_ids: [1] } as never, () => true);
    activateInstinct(memory, id);
    const { "X-Usac-Token": _t, ...noToken } = OK_HEADERS;
    expect((await post(app, `/api/instincts/${id}/retire`, { reason: "unnoetig" }, noToken)).status).toBe(403);
    expect((await post(app, `/api/instincts/${id}/retire`, { reason: "unnoetig" }, { ...OK_HEADERS, Origin: "http://evil.test" })).status).toBe(403);
    expect(getInstinct(memory, id)!.status).toBe("active");
    expect((await app.request(`http://127.0.0.1:7777/api/instincts/${id}/retire`, { headers: OK_HEADERS })).status).toBe(405);
    expect((await post(app, `/api/instincts/${id}/retire`, { reason: "  " })).status).toBe(400);
    expect((await post(app, `/api/instincts/999/retire`, { reason: "x" })).status).toBe(404);
    const res = await post(app, `/api/instincts/${id}/retire`, { reason: "unnoetig" });
    expect(res.status).toBe(200);
    const i = getInstinct(memory, id)!;
    expect(i.status).toBe("retired");
    expect(i.retire_reason).toBe("unnoetig");
    // Bereits stillgelegt: nicht erneut entscheiden.
    expect((await post(app, `/api/instincts/${id}/retire`, { reason: "anders" })).status).toBe(409);
    expect(getInstinct(memory, id)!.retire_reason).toBe("unnoetig");
  });

  test("Verifizieren außerhalb eines Projekts", async () => {
    const { memory, app, projectPath } = setup();
    addEntry(memory, { kind: "fact", text: COOLDOWN, evidence: [{ file: "src/rotation.lua", lines: "2", quote: QUOTE }] });
    const uid = memoryUid("fact", COOLDOWN);
    expect((await post(app, `/api/memory/${uid}/verify`, { root: "/etc" })).status).toBe(400);
    expect((await post(app, `/api/memory/${uid}/verify`, { root: join(projectPath, "..") })).status).toBe(400);
    expect((await post(app, `/api/memory/${uid}/verify`, {})).status).toBe(400);
    expect(search(memory, "cooldown")[0]!.status).toBe("proposed");
    const { "X-Usac-Token": _t, ...noToken } = OK_HEADERS;
    expect((await post(app, `/api/memory/${uid}/verify`, { root: projectPath }, noToken)).status).toBe(403);
    expect((await post(app, `/api/memory/0000000000000000/verify`, { root: projectPath })).status).toBe(404);
    expect(search(memory, "cooldown")[0]!.status).toBe("proposed");
  });
});
