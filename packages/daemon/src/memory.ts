import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type MemoryStatus = "proposed" | "verified" | "stale";
export interface Evidence { file: string; lines: string; quote: string }
export interface MemoryEntry {
  id?: number;
  kind: string;
  text: string;
  status?: MemoryStatus;
  created_at?: string;
  evidence: Evidence[];
}

export function openMemory(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','verified','stale')),
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS evidence (
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    file TEXT NOT NULL,
    lines TEXT NOT NULL,
    quote TEXT NOT NULL
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, kind, content='entries', content_rowid='id')`);
  return db;
}

/** Neue Eintraege sind immer `proposed`; ohne Beleg wird abgelehnt. */
export function addEntry(db: Database, entry: MemoryEntry): number {
  const ev = entry.evidence ?? [];
  if (ev.length === 0 || ev.some((e) => !e.file?.trim() || !e.quote?.trim())) {
    throw new Error("Memory-Eintrag ohne Beleg (file, quote) abgelehnt");
  }
  if (ev.some((e) => e.quote.trim().length < 8 || !/^\d+(-\d+)?$/.test(e.lines ?? ""))) {
    throw new Error("Memory-Eintrag mit trivialem Zitat (min. 8 Zeichen) oder ungueltigen Zeilen (z. B. 3 oder 3-7) abgelehnt");
  }
  let id = 0;
  db.transaction(() => {
    const r = db
      .query("INSERT INTO entries(kind, text, status, created_at) VALUES (?, ?, 'proposed', ?)")
      .run(entry.kind, entry.text, new Date().toISOString());
    id = Number(r.lastInsertRowid);
    for (const e of ev) {
      db.query("INSERT INTO evidence(entry_id, file, lines, quote) VALUES (?, ?, ?, ?)").run(id, e.file, e.lines ?? "", e.quote);
    }
    db.query("INSERT INTO entries_fts(rowid, text, kind) VALUES (?, ?, ?)").run(id, entry.text, entry.kind);
  })();
  return id;
}

function load(db: Database, rows: Array<{ id: number; kind: string; text: string; status: string; created_at: string }>): MemoryEntry[] {
  return rows.map((r) => ({
    ...r,
    status: r.status as MemoryStatus,
    evidence: db.query("SELECT file, lines, quote FROM evidence WHERE entry_id = ?").all(r.id) as Evidence[],
  }));
}

export function search(db: Database, query: string): MemoryEntry[] {
  // Jedes Wort als Phrase quoten, damit Nutzereingaben keine FTS-Syntax ausloesen.
  const q = query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
  if (!q) return [];
  const rows = db
    .query("SELECT e.id, e.kind, e.text, e.status, e.created_at FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ? ORDER BY rank")
    .all(q) as Array<{ id: number; kind: string; text: string; status: string; created_at: string }>;
  return load(db, rows);
}

export function setStatus(db: Database, id: number, status: MemoryStatus): void {
  db.query("UPDATE entries SET status = ? WHERE id = ?").run(status, id);
}

/** Mechanische Pruefung: jedes Zitat muss woertlich in der Datei unter `root` stehen. Setzt dann verified. */
export function verifyEntry(db: Database, id: number, root: string): boolean {
  const ev = db.query("SELECT file, quote FROM evidence WHERE entry_id = ?").all(id) as Evidence[];
  if (ev.length === 0) return false;
  const base = resolve(root);
  const paths = ev.map((e) => {
    const full = resolve(base, e.file);
    const rel = relative(base, full);
    if (isAbsolute(e.file) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Beleg-Pfad ausserhalb von root: ${e.file}`);
    }
    return full;
  });
  const ok = ev.every((e, i) => {
    try {
      return readFileSync(paths[i]!, "utf8").replace(/\r\n/g, "\n").includes(e.quote.replace(/\r\n/g, "\n"));
    } catch {
      return false;
    }
  });
  if (ok) setStatus(db, id, "verified");
  return ok;
}

/** Schreibt je verified-Eintrag eine Markdown-Datei nach outDir. Liefert die Anzahl. */
export function exportVerified(db: Database, outDir: string): number {
  const rows = db
    .query("SELECT id, kind, text, status, created_at FROM entries WHERE status = 'verified' ORDER BY id")
    .all() as Array<{ id: number; kind: string; text: string; status: string; created_at: string }>;
  mkdirSync(outDir, { recursive: true });
  const names = new Set<string>();
  for (const e of load(db, rows)) {
    const md = [
      `# ${e.kind} ${e.id}`,
      "",
      e.text,
      "",
      `Status: ${e.status}`,
      `Erstellt: ${e.created_at}`,
      "",
      "## Belege",
      ...e.evidence.map((v) => `- ${v.file}:${v.lines}\n  > ${v.quote.replace(/\n/g, "\n  > ")}`),
      "",
    ].join("\n");
    const name = `${e.kind.replace(/[^\w-]/g, "_")}-${e.id}.md`;
    names.add(name);
    writeFileSync(join(outDir, name), md);
  }
  // Veraltete Export-Dateien (Muster <kind>-<id>.md) entfernen; fremde Dateien bleiben.
  for (const f of readdirSync(outDir)) {
    if (/^[\w-]+-\d+\.md$/.test(f) && !names.has(f)) rmSync(join(outDir, f));
  }
  return rows.length;
}
