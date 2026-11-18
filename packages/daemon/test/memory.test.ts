import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, exportVerified, openMemory, search, setStatus, verifyEntry } from "../src/memory";

const tmp = () => mkdtempSync(join(tmpdir(), "usac-mem-"));
const ev = { file: "a.lua", lines: "1-2", quote: "local x = 1" };

describe("memory", () => {
  test("Eintrag ohne Beleg wird abgelehnt", () => {
    const db = openMemory(join(tmp(), "m.db"));
    expect(() => addEntry(db, { kind: "rule", text: "x", evidence: [] })).toThrow();
    expect(search(db, "x")).toEqual([]);
  });

  test("FTS5-Suche findet Eintrag ueber Stichwort", () => {
    const db = openMemory(join(tmp(), "m.db"));
    addEntry(db, { kind: "rule", text: "Cooldown wird ignoriert", evidence: [ev] });
    addEntry(db, { kind: "rule", text: "Anderes Thema", evidence: [ev] });
    const hits = search(db, "Cooldown");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.status).toBe("proposed");
    expect(hits[0]!.evidence[0]!.quote).toBe("local x = 1");
  });

  test("Export nimmt nur verified-Eintraege", () => {
    const db = openMemory(join(tmp(), "m.db"));
    const a = addEntry(db, { kind: "rule", text: "gut", evidence: [ev] });
    addEntry(db, { kind: "rule", text: "offen", evidence: [ev] });
    const c = addEntry(db, { kind: "rule", text: "alt", evidence: [ev] });
    setStatus(db, a, "verified");
    setStatus(db, c, "verified");
    setStatus(db, c, "stale");
    const out = tmp();
    expect(exportVerified(db, out)).toBe(1);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    const md = readFileSync(join(out, files[0]!), "utf8");
    expect(md).toContain("gut");
    expect(md).toContain("a.lua");
    expect(md).toContain("local x = 1");
  });

  test("verifyEntry prueft Zitat mechanisch gegen die Datei", () => {
    const root = tmp();
    writeFileSync(join(root, "a.lua"), "local x = 1\nreturn x\n");
    const db = openMemory(join(tmp(), "m.db"));
    const ok = addEntry(db, { kind: "rule", text: "ok", evidence: [ev] });
    const bad = addEntry(db, { kind: "rule", text: "bad", evidence: [{ ...ev, quote: "nicht vorhanden" }] });
    expect(verifyEntry(db, ok, root)).toBe(true);
    expect(verifyEntry(db, bad, root)).toBe(false);
    expect(search(db, "ok")[0]!.status).toBe("verified");
    expect(search(db, "bad")[0]!.status).toBe("proposed");
    expect(existsSync(root)).toBe(true);
  });
});
