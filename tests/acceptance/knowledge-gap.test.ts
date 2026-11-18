import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence } from "../../packages/daemon/src/evidence";
import { git } from "../../packages/daemon/src/exec";
import { formatHits, keywords, MAX_HITS, resolveGap, type GapContext } from "../../packages/daemon/src/knowledge";
import { addEntry, checkMemoryEvidence, openMemory, setStatus } from "../../packages/daemon/src/memory";
import { openStore } from "../../packages/daemon/src/store";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const Q = "cooldown priority";

/** Git-Repo aus dem Lua-Fixture; optional mit echtem graph.json und Zusatzdateien. */
async function project(opts: { graph?: boolean; files?: Record<string, string>; noFixture?: boolean } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "usac-gap-"));
  if (!opts.noFixture) cpSync(join(FIXTURES, "lua-rotation"), dir, { recursive: true });
  if (opts.graph ?? true) {
    mkdirSync(join(dir, "graphify-out"));
    copyFileSync(join(FIXTURES, "graph", "graph.json"), join(dir, "graphify-out", "graph.json"));
  }
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  return dir;
}

type Ev = { type: string; data: any };
function context(cwd: string): GapContext & { events: Ev[] } {
  const home = mkdtempSync(join(tmpdir(), "usac-gap-home-"));
  const events: Ev[] = [];
  return {
    cwd,
    store: openStore(join(home, "usac.db")),
    memory: openMemory(join(home, "memory.db")),
    workItemId: "w1",
    emit: (type, data) => events.push({ type, data }),
    events,
  };
}

const searched = (events: Ev[]) => events.filter((e) => e.type === "gap.searched").map((e) => e.data.source);

describe("Wissenslücken-Pipeline (Phase 3)", () => {
  test("eine Wissenslücke wird in dieser Reihenfolge geschlossen", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("code");
    expect(searched(ctx.events)).toEqual(["memory", "graph", "code"]);
    expect(ctx.events.at(-1)).toEqual({ type: "gap.resolved", data: { question: Q, source: "code" } });
    if (r.source === "user") throw new Error("unerwartet");
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.evidence.type).toBe("file");
      expect(checkEvidence(h.evidence, { cwd, store: ctx.store, workItemId: "w1" })).toBeNull();
    }
    expect(r.hits.map((h) => (h.evidence as { path: string }).path)).toContain("src/rotation.lua");
    expect(formatHits(Q, r.hits)).toContain("src/rotation.lua");
  });

  test("ohne Treffer wird der Nutzer gefragt", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    const q = "zauberstab einhorn";
    const r = await resolveGap(q, ctx);
    expect(r.source).toBe("user");
    expect(searched(ctx.events)).toEqual(["memory", "graph", "code", "docs"]);
    if (r.source !== "user") throw new Error("unerwartet");
    const a = ctx.store.getApproval(r.approvalId)!;
    expect(a).toMatchObject({ kind: "question", status: "pending", workItemId: "w1" });
    expect(a.context).toEqual({ question: q, searched: ["memory", "graph", "code", "docs"] });
    expect(ctx.events.at(-1)).toEqual({ type: "gap.asked_user", data: { question: q, approval_id: r.approvalId } });
  });

  test("after setzt die Suche fort", async () => {
    const cwd = await project({ files: { "docs/x.md": "Der cooldown hat Vorrang vor priority.\n" } });
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx, "code");
    expect(r.source).toBe("docs");
    expect(searched(ctx.events)).toEqual(["docs"]);
  });

  test("Memory zuerst", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    const quote = "-- @param spells table Liste von { name = string, priority = number, cooldown = number }";
    const id = addEntry(ctx.memory, {
      kind: "fact",
      text: "Jeder Zauber hat cooldown und priority",
      evidence: [{ file: "src/rotation.lua", lines: "4", quote }],
    });
    setStatus(ctx.memory, id, "verified");
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("memory");
    expect(searched(ctx.events)).toEqual(["memory"]);
    if (r.source === "user") throw new Error("unerwartet");
    const ev = r.hits[0]!.evidence;
    expect(ev.type).toBe("memory");
    expect(checkEvidence(ev, { ...ctx, memory: { check: (u, d) => checkMemoryEvidence(ctx.memory, u, d) } })).toBeNull();
  });

  test("Memory: nur verified zählt", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    addEntry(ctx.memory, {
      kind: "fact",
      text: "Jeder Zauber hat cooldown und priority",
      evidence: [{ file: "src/rotation.lua", lines: "4", quote: "cooldown = number" }],
    });
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("code");
  });

  test("fehlender Graph", async () => {
    const cwd = await project({ graph: false });
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx);
    const un = ctx.events.find((e) => e.type === "gap.source_unavailable");
    expect(un?.data.source).toBe("graph");
    expect(typeof un?.data.reason).toBe("string");
    expect(r.source).toBe("code");
  });

  test("Graph liefert prüfbare Belege", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    const r = await resolveGap("next_spell", ctx);
    expect(r.source).toBe("graph");
    if (r.source === "user") throw new Error("unerwartet");
    for (const h of r.hits) {
      expect(h.evidence.type).toBe("graph");
      expect(checkEvidence(h.evidence, { cwd, store: ctx.store, workItemId: "w1" })).toBeNull();
    }
  });

  test("Sonderzeichen in der Frage", async () => {
    const cwd = await project();
    const ctx = context(cwd);
    const q = 'Was macht "cooldown" AND NOT x – heißt es ß?';
    expect(() => keywords(q)).not.toThrow();
    for (const k of keywords(q)) expect(k).toMatch(/^[\p{L}\p{N}_]{4,}$/u);
    expect(keywords(q)).toContain("cooldown");
    await expect(resolveGap(q, ctx)).resolves.toBeDefined();
  });

  test("keywords: klein, ohne Stoppwörter, höchstens 6", () => {
    expect(keywords("Where does THE Cooldown happen from?")).toEqual(["cooldown", "happen"]);
    expect(keywords("Warum wird dieser Zauber nicht gewählt?")).not.toContain("dieser");
    expect(keywords("alpha bravo charlie delta echoo foxtrot golfo hotel").length).toBe(6);
  });

  test("Doku und Code getrennt", async () => {
    const cwd = await project({ noFixture: true, graph: false, files: { "docs/x.md": "Der cooldown schlägt priority.\n", "src/a.lua": "return 1\n" } });
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("docs");
    expect(searched(ctx.events)).toContain("code");
    if (r.source === "user") throw new Error("unerwartet");
    expect(r.hits.map((h) => (h.evidence as { path: string }).path)).toEqual(["docs/x.md"]);
  });

  test("höchstens 5 Treffer je Quelle", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `local c${i} = cooldown * priority`).join("\n") + "\n";
    const cwd = await project({ files: { "src/many.lua": many } });
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("code");
    if (r.source === "user") throw new Error("unerwartet");
    expect(MAX_HITS).toBe(5);
    expect(r.hits.length).toBe(5);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("Binärdateien und graphify-out zählen nicht als Code", async () => {
    const cwd = await project({
      noFixture: true,
      files: { "bin.dat": "cooldown priority\u0000\u0001", "graphify-out/notes.txt": "cooldown priority\n" },
    });
    const ctx = context(cwd);
    const r = await resolveGap(Q, ctx);
    expect(r.source).toBe("user");
  });
});
