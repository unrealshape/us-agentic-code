/**
 * Abnahme Phase 4, Task 5: eigene Test-Datenbank je Aufgabe.
 * SQLite-Datei je Work-Item unter .usac-tmp/ bzw. lokale PostgreSQL-Datenbank per createdb/dropdb.
 * Der echte PostgreSQL-Test laeuft nur mit USAC_PG_TESTS=1.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, sh } from "../../packages/daemon/src/exec";
import { createTestDb, testDbName } from "../../packages/daemon/src/testdb";

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "usac-testdb-"));
  await git(dir, "init", "-q");
  return dir;
}

function pathOf(url: string | undefined): string {
  if (url === undefined) throw new Error("DATABASE_URL fehlt");
  expect(url.startsWith("file:")).toBe(true);
  return url.slice("file:".length);
}

describe("Test-Datenbank je Task", () => {
  test("Name ist gültig", () => {
    expect(testDbName("wi_AB-c")).toBe("usac_wi_ab_c");
    const long = testDbName("x".repeat(100));
    expect(long.length).toBe(63);
    expect(long).toMatch(/^usac_[a-z0-9_]+$/);
  });

  test("sqlite je Task getrennt", async () => {
    const cwd = await repo();
    const a = await createTestDb({ wiId: "wi_1", cwd, cfg: { kind: "sqlite" } });
    const b = await createTestDb({ wiId: "wi_2", cwd, cfg: { kind: "sqlite" } });
    const pa = pathOf(a.env.DATABASE_URL);
    const pb = pathOf(b.env.DATABASE_URL);
    expect(pa).not.toBe(pb);
    expect(pa).toBe(join(cwd, ".usac-tmp", "usac_wi_1.db"));
    expect(existsSync(pa)).toBe(true);
    expect(existsSync(pb)).toBe(true);

    const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".usac-tmp/");

    await a.drop();
    expect(existsSync(pa)).toBe(false);
    expect(existsSync(pb)).toBe(true);
    await b.drop();
  });

  test("Vorlage wird kopiert", async () => {
    const cwd = await repo();
    const template = join(cwd, "template.db");
    const tdb = new Database(template);
    tdb.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    tdb.close();

    const db = await createTestDb({ wiId: "wi_tpl", cwd, cfg: { kind: "sqlite", template: "template.db" } });
    const conn = new Database(pathOf(db.env.DATABASE_URL), { readonly: true });
    const rows = conn.query("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").all();
    conn.close();
    expect(rows.length).toBe(1);
    await db.drop();
  });

  test("postgres ohne createdb", async () => {
    const fakeSh: typeof sh = async () => ({ exitCode: 127, output: "createdb: command not found", durationMs: 1, timedOut: false });
    await expect(
      createTestDb({ wiId: "wi_pg", cwd: tmpdir(), cfg: { kind: "postgres" }, sh: fakeSh }),
    ).rejects.toThrow("createdb nicht gefunden: lokales PostgreSQL installieren oder test_db.kind sqlite wählen");
  });

  test("postgres ruft createdb mit Vorlage und dropdb auf", async () => {
    const calls: string[] = [];
    const fakeSh: typeof sh = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, output: "", durationMs: 1, timedOut: false };
    };
    const db = await createTestDb({ wiId: "wi_PG", cwd: tmpdir(), cfg: { kind: "postgres", template_db: "app_tpl" }, sh: fakeSh });
    expect(db.env.DATABASE_URL).toBe("postgresql:///usac_wi_pg");
    expect(calls[0]).toBe("createdb -T 'app_tpl' usac_wi_pg");
    await db.drop();
    expect(calls[1]).toBe("dropdb --if-exists usac_wi_pg");
  });

  test.skipIf(process.env.USAC_PG_TESTS !== "1")("postgres echt (USAC_PG_TESTS=1)", async () => {
    const db = await createTestDb({ wiId: `wi_real_${Date.now()}`, cwd: tmpdir(), cfg: { kind: "postgres" } });
    const name = (db.env.DATABASE_URL ?? "").slice("postgresql:///".length);
    const list = async () => (await sh("psql -lqt", tmpdir())).output;
    expect(await list()).toContain(name);
    await db.drop();
    expect(await list()).not.toContain(name);
  });
});
