/**
 * Eigene Test-Datenbank je Aufgabe (Phase 4, Task 5).
 * Nur SQLite (Datei unter .usac-tmp/) und lokales PostgreSQL (createdb/dropdb); kein MySQL, kein Docker.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { sh as defaultSh } from "./exec";
import { excludeFromGit } from "./graph";

export const TestDbConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sqlite"), template: z.string().optional() }),
  z.object({ kind: z.literal("postgres"), template_db: z.string().optional() }),
]);
export type TestDbConfig = z.infer<typeof TestDbConfig>;

export interface TestDb {
  env: Record<string, string>;
  drop(): Promise<void>;
}

const TMP_DIR = ".usac-tmp";
const MAX_NAME = 63; // PostgreSQL-Grenze fuer Bezeichner (NAMEDATALEN - 1)

/** Datenbankname je Work-Item: `usac_` + Kleinbuchstaben, alles ausser [a-z0-9] → `_`, hoechstens 63 Zeichen. */
export function testDbName(wiId: string): string {
  return ("usac_" + wiId.toLowerCase().replace(/[^a-z0-9]/g, "_")).slice(0, MAX_NAME);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Legt die Test-Datenbank fuer ein Work-Item an und liefert DATABASE_URL sowie eine Aufraeum-Funktion. */
export async function createTestDb(opts: {
  wiId: string;
  cwd: string;
  cfg: TestDbConfig;
  sh?: typeof defaultSh;
}): Promise<TestDb> {
  const name = testDbName(opts.wiId);
  const cfg = TestDbConfig.parse(opts.cfg);

  if (cfg.kind === "sqlite") {
    const dir = join(opts.cwd, TMP_DIR);
    mkdirSync(dir, { recursive: true });
    try {
      await excludeFromGit(opts.cwd, [`${TMP_DIR}/`]);
    } catch {
      // kein Git-Repo: nichts auszuschliessen
    }
    const file = join(dir, `${name}.db`);
    rmSync(file, { force: true });
    if (cfg.template) {
      copyFileSync(isAbsolute(cfg.template) ? cfg.template : join(opts.cwd, cfg.template), file);
    } else {
      writeFileSync(file, ""); // leere Datei ist eine gueltige leere SQLite-Datenbank
    }
    return {
      env: { DATABASE_URL: `file:${file}` },
      async drop() {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
      },
    };
  }

  const run = opts.sh ?? defaultSh;
  const template = cfg.template_db ? `-T ${shellQuote(cfg.template_db)} ` : "";
  const res = await run(`createdb ${template}${name}`, opts.cwd);
  if (res.exitCode === 127) {
    throw new Error("createdb nicht gefunden: lokales PostgreSQL installieren oder test_db.kind sqlite wählen");
  }
  if (res.exitCode !== 0) throw new Error(`createdb ${name} fehlgeschlagen (${res.exitCode}): ${res.output}`);
  return {
    env: { DATABASE_URL: `postgresql:///${name}` },
    async drop() {
      const r = await run(`dropdb --if-exists ${name}`, opts.cwd);
      if (r.exitCode !== 0) throw new Error(`dropdb ${name} fehlgeschlagen (${r.exitCode}): ${r.output}`);
    },
  };
}
