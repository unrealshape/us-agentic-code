import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAnswer,
  addEntry,
  checkMemoryEvidence,
  exportVerified,
  importEntries,
  memoryUid,
  openMemory,
  resolveConflict,
  search,
  setStatus,
  verifyEntry,
} from "../src/memory";

const tmp = () => mkdtempSync(join(tmpdir(), "usac-mem2-"));
const opened: Database[] = [];
const open = (p: string) => { const d = openMemory(p); opened.push(d); return d; };
const ev = { file: "a.lua", lines: "1-3", quote: "local x = 1" };

function verified(db: Database, text: string, evidence = [ev]): number {
  const id = addEntry(db, { kind: "rule", text, evidence });
  setStatus(db, id, "verified");
  return id;
}

const uidRow = (db: Database, id: number) =>
  db.query("SELECT uid, origin, status FROM entries WHERE id = ?").get(id) as { uid: string; origin: string; status: string };

describe("memory v2", () => {
  afterEach(() => { while (opened.length) opened.pop()!.close(); });

  test("UID ist SHA-256 ueber kind und text, erste 16 Hex-Zeichen", () => {
    const db = open(join(tmp(), "m.db"));
    const id = verified(db, "Cooldown zaehlt");
    const h = new Bun.CryptoHasher("sha256").update("rule\nCooldown zaehlt").digest("hex").slice(0, 16);
    expect(uidRow(db, id).uid).toBe(h);
    expect(memoryUid("rule", "Cooldown zaehlt")).toBe(h);
    expect(uidRow(db, id).origin).toBe("local");
  });

  test("gleiche lokale ID auf zwei Rechnern ergibt zwei Dateien", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    expect(verified(a, "Wissen von Rechner A")).toBe(1);
    expect(verified(b, "Wissen von Rechner B")).toBe(1);
    const out = tmp();
    exportVerified(a, out);
    exportVerified(b, out);
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^rule-[0-9a-f]{16}\.md$/);
    const md = readFileSync(join(out, `rule-${memoryUid("rule", "Wissen von Rechner A")}.md`), "utf8");
    expect(md).toContain(`uid: ${memoryUid("rule", "Wissen von Rechner A")}`);
    expect(md).toContain("kind: rule");
    expect(md).toContain("status: verified");
    expect(md).toMatch(/updated: \S+/);
  });

  test("Import uebernimmt fremde Eintraege mit Herkunft remote", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "Rotation beachtet Cooldowns");
    const out = tmp();
    exportVerified(a, out);
    writeFileSync(join(out, "README.md"), "fremde Datei");
    writeFileSync(join(out, "rule-zzzz.md"), "kein Export");
    const r = importEntries(b, out);
    expect(r).toEqual({ imported: 1, conflicts: [] });
    const hits = search(b, "Cooldowns");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.origin).toBe("remote");
    expect(hits[0]!.status).toBe("verified");
    expect(hits[0]!.uid).toBe(memoryUid("rule", "Rotation beachtet Cooldowns"));
    expect(hits[0]!.evidence).toEqual([{ file: "a.lua", lines: "1-3", quote: "local x = 1", kind: "file" }]);
    // Zweiter Import ist idempotent.
    expect(importEntries(b, out)).toEqual({ imported: 0, conflicts: [] });
  });

  test("mehrzeiliges Zitat uebersteht Export und Import", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "Zwei Zeilen\nText", [{ file: "src/x.lua", lines: "4-5", quote: "local a = 1\nlocal b = 2" }]);
    const out = tmp();
    exportVerified(a, out);
    expect(importEntries(b, out).imported).toBe(1);
    const hit = search(b, "Zeilen")[0]!;
    expect(hit.text).toBe("Zwei Zeilen\nText");
    expect(hit.evidence[0]).toEqual({ file: "src/x.lua", lines: "4-5", quote: "local a = 1\nlocal b = 2", kind: "file" });
  });

  test("Statuskonflikt", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "gleiches Wissen");
    const local = verified(b, "gleiches Wissen");
    const out = tmp();
    exportVerified(a, out);
    const file = join(out, `rule-${memoryUid("rule", "gleiches Wissen")}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: verified", "status: stale"));
    const r = importEntries(b, out);
    expect(r.imported).toBe(0);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.reason).toBe("status");
    expect(c.uid).toBe(memoryUid("rule", "gleiches Wissen"));
    expect(c.local.status).toBe("verified");
    expect(c.remote.status).toBe("stale");
    expect(uidRow(b, local).status).toBe("verified");
    resolveConflict(b, c, "remote");
    expect(uidRow(b, local).status).toBe("stale");
  });

  test("Ankerkonflikt", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "Zeile 2 setzt den Cooldown", [{ file: "a.lua", lines: "2-4", quote: "local cd = 5" }]);
    const local = verified(b, "Zeile 2 setzt den Timer", [{ file: "a.lua", lines: "1-2", quote: "local x = 1" }]);
    const out = tmp();
    exportVerified(a, out);
    const r = importEntries(b, out);
    expect(r.imported).toBe(0);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.reason).toBe("anchor");
    expect(r.conflicts[0]!.local.id).toBe(local);
    expect(r.conflicts[0]!.remote.text).toBe("Zeile 2 setzt den Cooldown");
    resolveConflict(b, r.conflicts[0]!, "both");
    expect(search(b, "Cooldown")[0]!.origin).toBe("remote");
    expect(uidRow(b, local).status).toBe("verified");
  });

  test("Ankerkonflikt: Wahl remote macht lokalen Eintrag stale", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "fern", [{ file: "a.lua", lines: "3", quote: "local cd = 5" }]);
    const local = verified(b, "lokal", [{ file: "a.lua", lines: "1-3", quote: "local x = 1" }]);
    const out = tmp();
    exportVerified(a, out);
    const c = importEntries(b, out).conflicts[0]!;
    expect(c.reason).toBe("anchor");
    resolveConflict(b, c, "remote");
    expect(uidRow(b, local).status).toBe("stale");
    expect(search(b, "fern")[0]!.status).toBe("verified");
  });

  test("keine Ankerkonflikte bei getrennten Zeilen", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    verified(a, "fern", [{ file: "a.lua", lines: "5-6", quote: "local cd = 5" }]);
    verified(b, "lokal", [{ file: "a.lua", lines: "1-4", quote: "local x = 1" }]);
    const out = tmp();
    exportVerified(a, out);
    expect(importEntries(b, out)).toEqual({ imported: 1, conflicts: [] });
  });

  test("Antwort des Nutzers bleibt lokal", () => {
    const db = open(join(tmp(), "m.db"));
    const uid = addAnswer(db, "Welcher Cooldown gilt?", "Immer der globale Cooldown", 42);
    expect(uid).toMatch(/^[0-9a-f]{16}$/);
    const hits = search(db, "globale");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("answer");
    expect(hits[0]!.status).toBe("verified");
    expect(hits[0]!.uid).toBe(uid);
    expect(hits[0]!.evidence[0]!.kind).toBe("approval");
    const out = tmp();
    expect(exportVerified(db, out)).toBe(0);
    expect(readdirSync(out)).toEqual([]);
    expect(checkMemoryEvidence(db, uid, tmp())).toBeNull();
  });

  test("veralteter Beleg wird stale", () => {
    const root = tmp();
    writeFileSync(join(root, "a.lua"), "local x = 1\nreturn x\n");
    const db = open(join(tmp(), "m.db"));
    const id = addEntry(db, { kind: "rule", text: "x ist eins", evidence: [ev] });
    expect(verifyEntry(db, id, root)).toBe(true);
    const { uid } = uidRow(db, id);
    expect(checkMemoryEvidence(db, uid, root)).toBeNull();
    writeFileSync(join(root, "a.lua"), "local x = 2\nreturn x\n");
    const msg = checkMemoryEvidence(db, uid, root);
    expect(msg).toBeString();
    expect(msg).toContain("a.lua");
    expect(uidRow(db, id).status).toBe("stale");
    expect(checkMemoryEvidence(db, "0000000000000000", root)).toBeString();
  });

  test("Export entfernt nur eigene veraltete und alte Dateien", () => {
    const a = open(join(tmp(), "a.db"));
    const b = open(join(tmp(), "b.db"));
    const mine = verified(a, "eigenes");
    verified(b, "fremdes");
    const out = tmp();
    exportVerified(b, out);
    writeFileSync(join(out, "rule-7.md"), "altes Muster");
    writeFileSync(join(out, "README.md"), "bleibt");
    exportVerified(a, out);
    setStatus(a, mine, "stale");
    exportVerified(a, out);
    expect(readdirSync(out).sort()).toEqual([`rule-${memoryUid("rule", "fremdes")}.md`, "README.md"].sort());
  });

  test("alte Datenbank wird migriert", () => {
    const path = join(tmp(), "old.db");
    const old = new Database(path);
    old.run(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','verified','stale')),
      created_at TEXT NOT NULL
    )`);
    old.run(`CREATE TABLE evidence (
      entry_id INTEGER NOT NULL REFERENCES entries(id),
      file TEXT NOT NULL,
      lines TEXT NOT NULL,
      quote TEXT NOT NULL
    )`);
    old.run(`CREATE VIRTUAL TABLE entries_fts USING fts5(text, kind, content='entries', content_rowid='id')`);
    for (const t of ["alt eins", "alt zwei", "alt eins"]) {
      const r = old.query("INSERT INTO entries(kind, text, status, created_at) VALUES ('rule', ?, 'verified', '2026-01-01T00:00:00Z')").run(t);
      old.query("INSERT INTO evidence(entry_id, file, lines, quote) VALUES (?, 'a.lua', '1', 'local x = 1')").run(r.lastInsertRowid);
      old.query("INSERT INTO entries_fts(rowid, text, kind) VALUES (?, ?, 'rule')").run(r.lastInsertRowid, t);
    }
    old.close();
    const db = open(path);
    expect(uidRow(db, 1).uid).toBe(memoryUid("rule", "alt eins"));
    expect(uidRow(db, 2).uid).toBe(memoryUid("rule", "alt zwei"));
    expect(uidRow(db, 3).uid).toMatch(/^[0-9a-f]{16}$/);
    expect(uidRow(db, 3).uid).not.toBe(uidRow(db, 1).uid);
    expect(uidRow(db, 1).origin).toBe("local");
    expect(search(db, "zwei")[0]!.evidence[0]!.kind).toBe("file");
    db.close();
    opened.pop();
    // Zweites Oeffnen migriert nicht erneut.
    const again = open(path);
    expect(uidRow(again, 1).uid).toBe(memoryUid("rule", "alt eins"));
  });
});
