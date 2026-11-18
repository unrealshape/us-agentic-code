import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, exportVerified, memoryUid, openMemory, search, setStatus, type Evidence } from "../../packages/daemon/src/memory";
import { realGit } from "../../packages/daemon/src/integrator";
import { Store } from "../../packages/daemon/src/store";
import { applyConflictDecisions, pullMemory } from "../../packages/daemon/src/sync";

const tmp = () => mkdtempSync(join(tmpdir(), "usac-sync-"));
const ev: Evidence = { file: "a.lua", lines: "1-3", quote: "local x = 1" };
const opened: Array<Database | Store> = [];
const mem = () => { const d = openMemory(join(tmp(), "m.db")); opened.push(d); return d; };
const store = () => { const s = new Store(join(tmp(), "s.db")); opened.push(s); return s; };

async function git(cwd: string, ...args: string[]) {
  const r = await realGit(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.output}`);
  return r.output;
}
const commit = (cwd: string, msg: string) =>
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg);

/** Bare-Repo `origin` als usac-memory-Ersatz plus zwei Klone (Rechner A und B). */
async function team() {
  const root = tmp();
  const origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  const a = join(root, "a");
  const b = join(root, "b");
  await git(root, "clone", "-q", origin, a);
  await git(a, "checkout", "-q", "-b", "main");
  await commit(a, "start");
  await git(a, "push", "-q", "-u", "origin", "main");
  await git(root, "clone", "-q", origin, b);
  return { a, b };
}

/** Rechner A exportiert, committet und pusht (macht hier der Test, nie sync.ts). */
async function publish(db: Database, dir: string) {
  exportVerified(db, dir);
  await git(dir, "add", "-A");
  await commit(dir, "export");
  await git(dir, "push", "-q");
}

function verified(db: Database, text: string, evidence: Evidence[] = [ev]): number {
  const id = addEntry(db, { kind: "rule", text, evidence });
  setStatus(db, id, "verified");
  return id;
}
const status = (db: Database, id: number) => (db.query("SELECT status FROM entries WHERE id = ?").get(id) as { status: string }).status;
const count = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
const conflictApprovals = (s: Store) => s.pendingApprovals().filter((p) => p.kind === "memory_conflict");

/** Statuskonflikt: A hat "gleiches Wissen" verified, B dasselbe nur proposed. */
async function statusConflict() {
  const t = await team();
  const dbA = mem();
  const dbB = mem();
  const s = store();
  verified(dbA, "gleiches Wissen");
  const local = addEntry(dbB, { kind: "rule", text: "gleiches Wissen", evidence: [ev] });
  await publish(dbA, t.a);
  return { ...t, dbA, dbB, s, local };
}

/** Ankerkonflikt: gleiche Zeilen in a.lua, anderer Text. */
async function anchorConflict() {
  const t = await team();
  const dbA = mem();
  const dbB = mem();
  const s = store();
  verified(dbA, "Zeile 2 setzt den Cooldown", [{ file: "a.lua", lines: "2-4", quote: "local cd = 5" }]);
  const local = verified(dbB, "Zeile 2 setzt den Timer", [{ file: "a.lua", lines: "1-2", quote: "local x = 1" }]);
  await publish(dbA, t.a);
  const r = await pullMemory({ dir: t.b, db: dbB, store: s, git: realGit });
  expect(r.conflicts).toBe(1);
  return { ...t, dbA, dbB, s, local, approvalId: r.approvalIds[0]! };
}

describe("Team-Abgleich (Phase 3)", () => {
  afterEach(() => { while (opened.length) opened.pop()!.close(); });

  test("Abgleich übernimmt Einträge des anderen Rechners", async () => {
    const { a, b } = await team();
    const dbA = mem();
    const dbB = mem();
    const s = store();
    verified(dbA, "Rotation beachtet Cooldowns");
    await publish(dbA, a);
    const r = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    expect(r).toEqual({ imported: 1, conflicts: 0, approvalIds: [] });
    const hit = search(dbB, "Cooldowns")[0]!;
    expect(hit.origin).toBe("remote");
    expect(hit.status).toBe("verified");
    const ev = s.events({ type: "memory.pulled" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ imported: 1, conflicts: 0 });
  });

  test("Konflikt erscheint in der Inbox", async () => {
    const { b, dbB, s } = await statusConflict();
    const r = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    expect(r.imported).toBe(0);
    expect(r.conflicts).toBe(1);
    const pending = conflictApprovals(s);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(r.approvalIds[0]!);
    const ctx = pending[0]!.context as { uid: string; reason: string; local: { status: string }; remote: { status: string } };
    expect(ctx.uid).toBe(memoryUid("rule", "gleiches Wissen"));
    expect(ctx.reason).toBe("status");
    expect(ctx.local.status).toBe("proposed");
    expect(ctx.remote.status).toBe("verified");
    expect(s.events({ type: "memory.conflict" }).map((e) => e.data)).toEqual([{ uid: ctx.uid, reason: "status" }]);
  });

  test("Entscheidung remote ersetzt den lokalen Eintrag", async () => {
    const { b, dbB, s, local } = await statusConflict();
    const r = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    s.resolveApproval(r.approvalIds[0]!, true, "remote");
    expect(applyConflictDecisions(dbB, s)).toBe(1);
    expect(status(dbB, local)).toBe("verified");
    expect(s.events({ type: "memory.conflict_resolved" }).map((e) => e.data)).toEqual([
      { uid: memoryUid("rule", "gleiches Wissen"), choice: "remote" },
    ]);
    // Bereits angewendete Entscheidungen zaehlen nicht noch einmal.
    expect(applyConflictDecisions(dbB, s)).toBe(0);
  });

  test("Entscheidung beide behält zwei Einträge", async () => {
    const { dbB, s, local, approvalId } = await anchorConflict();
    s.resolveApproval(approvalId, true, "beide");
    expect(applyConflictDecisions(dbB, s)).toBe(1);
    expect(count(dbB)).toBe(2);
    expect(status(dbB, local)).toBe("verified");
    expect(search(dbB, "Cooldown")[0]!.origin).toBe("remote");
  });

  test("abgelehnt behält lokal", async () => {
    const { dbB, s, local, approvalId } = await anchorConflict();
    s.resolveApproval(approvalId, false);
    expect(applyConflictDecisions(dbB, s)).toBe(1);
    expect(count(dbB)).toBe(1);
    expect(status(dbB, local)).toBe("verified");
    expect(s.events({ type: "memory.conflict_resolved" }).map((e) => (e.data as { choice: string }).choice)).toEqual(["local"]);
  });

  test("Entscheidung local wird gespeichert: erneuter Import fragt nicht noch einmal", async () => {
    const { b, dbB, s, local } = await statusConflict();
    const first = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    // Zweiter Abgleich vor der Entscheidung: keine zweite Freigabe fuer denselben Konflikt.
    const again = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    expect(again.approvalIds).toEqual([]);
    expect(conflictApprovals(s)).toHaveLength(1);
    s.resolveApproval(first.approvalIds[0]!, true, "local");
    expect(applyConflictDecisions(dbB, s)).toBe(1);
    expect(status(dbB, local)).toBe("proposed");
    const after = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    expect(after).toEqual({ imported: 0, conflicts: 0, approvalIds: [] });
    expect(conflictApprovals(s)).toHaveLength(0);
    expect(s.events({ type: "memory.conflict" })).toHaveLength(1);
  });

  test("geänderter ferner Stand erzeugt nach Entscheidung local wieder einen Konflikt", async () => {
    const { a, b, dbA, dbB, s } = await statusConflict();
    const first = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    s.resolveApproval(first.approvalIds[0]!, false);
    applyConflictDecisions(dbB, s);
    // A verifiziert neu (neuer Zeitstempel) und kommt mit einem weiteren Beleg.
    addEntry(dbA, { kind: "rule", text: "gleiches Wissen", evidence: [{ file: "b.lua", lines: "7", quote: "local y = 2" }] });
    setStatus(dbA, 1, "verified");
    await publish(dbA, a);
    const r = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    expect(r.conflicts).toBe(1);
    expect(conflictApprovals(s)).toHaveLength(1);
  });

  test("Export löscht keine Dateien des anderen Rechners", async () => {
    const { b, dbB, s } = await statusConflict();
    const file = join(b, `rule-${memoryUid("rule", "gleiches Wissen")}.md`);
    const r = await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    // B exportiert vor der Entscheidung (pre-push): A's Datei bleibt.
    exportVerified(dbB, b);
    expect(existsSync(file)).toBe(true);
    s.resolveApproval(r.approvalIds[0]!, true, "local");
    applyConflictDecisions(dbB, s);
    exportVerified(dbB, b);
    expect(existsSync(file)).toBe(true);
  });

  test("Export löscht keine importierten Einträge, die lokal veraltet sind", async () => {
    const { a, b } = await team();
    const dbA = mem();
    const dbB = mem();
    const s = store();
    verified(dbA, "fernes Wissen");
    await publish(dbA, a);
    await pullMemory({ dir: b, db: dbB, store: s, git: realGit });
    const file = join(b, `rule-${memoryUid("rule", "fernes Wissen")}.md`);
    setStatus(dbB, search(dbB, "fernes")[0]!.id!, "stale");
    exportVerified(dbB, b);
    expect(existsSync(file)).toBe(true);
  });

  test("nicht vorspulbarer Stand", async () => {
    const { a, b } = await team();
    const dbA = mem();
    const dbB = mem();
    const dbC = mem();
    const s = store();
    verified(dbA, "Wissen von A");
    await publish(dbA, a);
    // B hat einen eigenen, nicht gepushten Commit mit einer gueltigen Exportdatei: divergierende Historie.
    verified(dbC, "Wissen von C");
    exportVerified(dbC, b);
    writeFileSync(join(b, "notiz.txt"), "lokal");
    await git(b, "add", "-A");
    await commit(b, "lokal");
    await expect(pullMemory({ dir: b, db: dbB, store: s, git: realGit })).rejects.toThrow("git pull --ff-only fehlgeschlagen");
    expect(count(dbB)).toBe(0);
    expect(s.events({ type: "memory.pulled" })).toHaveLength(0);
    expect(readdirSync(b)).not.toContain(`rule-${memoryUid("rule", "Wissen von A")}.md`);
  });
});
