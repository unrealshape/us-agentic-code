import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, openMemory, setStatus } from "../../packages/daemon/src/memory";
import { runPrePushMemory } from "../../hooks/pre-push-memory";

const tmp = () => mkdtempSync(join(tmpdir(), "usac-mem-acc-"));
const ev = { file: "a.lua", lines: "1", quote: "q" };

describe("Memory-Abgleich (Phase 1)", () => {
  test("Hook bricht ab, wenn usac-memory nicht erreichbar ist, und exportiert nichts", () => {
    const db = join(tmp(), "m.db");
    const m = openMemory(db);
    setStatus(m, addEntry(m, { kind: "rule", text: "t", evidence: [ev] }), "verified");
    const target = join(tmp(), "usac-memory");
    const r = runPrePushMemory({ dbPath: db, targetDir: target, isReachable: () => false });
    expect(r.code).toBe(1);
    expect(() => readdirSync(target)).toThrow();
  });

  test("Hook exportiert nur verified in das Ziel und committet nicht", () => {
    const db = join(tmp(), "m.db");
    const m = openMemory(db);
    setStatus(m, addEntry(m, { kind: "rule", text: "t1", evidence: [ev] }), "verified");
    addEntry(m, { kind: "rule", text: "t2", evidence: [ev] });
    const target = join(tmp(), "usac-memory");
    mkdirSync(target);
    const calls: string[] = [];
    const r = runPrePushMemory({ dbPath: db, targetDir: target, isReachable: () => true, onGit: (a) => calls.push(a.join(" ")) });
    expect(r.code).toBe(0);
    expect(r.exported).toBe(1);
    expect(readdirSync(target)).toHaveLength(1);
    expect(calls.some((c) => /commit|push/.test(c))).toBe(false);
  });
});
