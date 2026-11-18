import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type MemoryStatus = "proposed" | "verified" | "stale";
export type MemoryOrigin = "local" | "remote";
export type EvidenceKind = "file" | "approval";
export interface Evidence { file: string; lines: string; quote: string; kind?: EvidenceKind }
export interface MemoryEntry {
  id?: number;
  uid?: string;
  kind: string;
  text: string;
  status?: MemoryStatus;
  origin?: MemoryOrigin;
  created_at?: string;
  updated_at?: string;
  evidence: Evidence[];
}
export type MemoryConflict = { uid: string; reason: "status" | "anchor"; local: MemoryEntry; remote: MemoryEntry };

const STATUSES: readonly MemoryStatus[] = ["proposed", "verified", "stale"];
const EXPORT_FILE = /^[\w-]+-[0-9a-f]{16}\.md$/;
const LEGACY_EXPORT_FILE = /^[\w-]+-\d+\.md$/;
const ENTRY_COLS = "id, uid, kind, text, status, origin, created_at, updated_at";

type Row = { id: number; uid: string; kind: string; text: string; status: string; origin: string; created_at: string; updated_at: string };

/** Inhaltsbasierte ID: erste 16 Hex-Zeichen von SHA-256 ueber `kind + "\n" + text`. */
export function memoryUid(kind: string, text: string): string {
  return new Bun.CryptoHasher("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 16);
}

const hasColumn = (db: Database, table: string, col: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);

/** Hebt Datenbanken aus Phase 1 auf das Schema v2 (uid, origin, updated_at, evidence.kind). Idempotent. */
function migrate(db: Database): void {
  db.transaction(() => {
    if (!hasColumn(db, "entries", "uid")) db.run("ALTER TABLE entries ADD COLUMN uid TEXT");
    if (!hasColumn(db, "entries", "origin")) {
      db.run("ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','remote'))");
    }
    if (!hasColumn(db, "entries", "updated_at")) db.run("ALTER TABLE entries ADD COLUMN updated_at TEXT");
    if (!hasColumn(db, "evidence", "kind")) {
      db.run("ALTER TABLE evidence ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file','approval'))");
    }
    db.run("UPDATE entries SET updated_at = created_at WHERE updated_at IS NULL");
    const missing = db.query("SELECT id, kind, text FROM entries WHERE uid IS NULL ORDER BY id").all() as Array<{ id: number; kind: string; text: string }>;
    const taken = db.query("SELECT 1 FROM entries WHERE uid = ?");
    for (const r of missing) {
      // Doppelte Eintraege aus Phase 1 (gleicher kind+text) bekommen eine aus der ID abgeleitete UID.
      let uid = memoryUid(r.kind, r.text);
      if (taken.get(uid)) uid = memoryUid(r.kind, `${r.text}\n#${r.id}`);
      db.query("UPDATE entries SET uid = ? WHERE id = ?").run(uid, r.id);
    }
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS entries_uid ON entries(uid)");
  })();
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
  // Team-Abgleich (sync.ts): je Konflikt-Fingerabdruck die Freigabe und die gespeicherte Entscheidung.
  db.run(`CREATE TABLE IF NOT EXISTS memory_conflicts (
    fingerprint TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('status','anchor')),
    approval_id INTEGER NOT NULL,
    choice TEXT CHECK (choice IN ('local','remote','both')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`);
  migrate(db);
  return db;
}

function validateFileEvidence(ev: Evidence[]): void {
  if (ev.length === 0 || ev.some((e) => !e.file?.trim() || !e.quote?.trim())) {
    throw new Error("Memory-Eintrag ohne Beleg (file, quote) abgelehnt");
  }
  if (ev.some((e) => e.quote.trim().length < 8 || !/^\d+(-\d+)?$/.test(e.lines ?? ""))) {
    throw new Error("Memory-Eintrag mit trivialem Zitat (min. 8 Zeichen) oder ungueltigen Zeilen (z. B. 3 oder 3-7) abgelehnt");
  }
}

/**
 * Legt einen Eintrag an oder ergaenzt einen bestehenden mit gleicher UID um neue Belege.
 * Kommen neue Belege hinzu, faellt der Eintrag auf `proposed` zurueck (muss neu verifiziert werden).
 */
function insertEntry(
  db: Database,
  e: { kind: string; text: string; status: MemoryStatus; origin: MemoryOrigin; created_at: string; updated_at: string },
  ev: Evidence[],
): { id: number; uid: string; created: boolean } {
  const uid = memoryUid(e.kind, e.text);
  let id = 0;
  let created = false;
  db.transaction(() => {
    const existing = db.query("SELECT id FROM entries WHERE uid = ?").get(uid) as { id: number } | null;
    if (existing) {
      id = existing.id;
      const have = db.query("SELECT file, lines, quote, kind FROM evidence WHERE entry_id = ?").all(id) as Evidence[];
      const fresh = ev.filter((v) => !have.some((h) => h.file === v.file && h.lines === v.lines && h.quote === v.quote && h.kind === (v.kind ?? "file")));
      for (const v of fresh) insertEvidence(db, id, v);
      if (fresh.length > 0 && e.status !== "verified") {
        db.query("UPDATE entries SET status = 'proposed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      }
      return;
    }
    const r = db
      .query("INSERT INTO entries(uid, kind, text, status, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uid, e.kind, e.text, e.status, e.origin, e.created_at, e.updated_at);
    id = Number(r.lastInsertRowid);
    created = true;
    for (const v of ev) insertEvidence(db, id, v);
    db.query("INSERT INTO entries_fts(rowid, text, kind) VALUES (?, ?, ?)").run(id, e.text, e.kind);
  })();
  return { id, uid, created };
}

function insertEvidence(db: Database, id: number, v: Evidence): void {
  db.query("INSERT INTO evidence(entry_id, file, lines, quote, kind) VALUES (?, ?, ?, ?, ?)").run(id, v.file, v.lines ?? "", v.quote, v.kind ?? "file");
}

/** Neue Eintraege sind immer `proposed`; ohne Beleg wird abgelehnt. */
export function addEntry(db: Database, entry: MemoryEntry): number {
  const ev = (entry.evidence ?? []).map((e) => ({ file: e.file, lines: e.lines, quote: e.quote, kind: "file" as const }));
  validateFileEvidence(ev);
  const now = new Date().toISOString();
  return insertEntry(db, { kind: entry.kind, text: entry.text, status: "proposed", origin: "local", created_at: now, updated_at: now }, ev).id;
}

/** Antwort des Nutzers auf eine Rueckfrage: Beleg ist die Freigabe, Status `verified`, wird nie exportiert. */
export function addAnswer(db: Database, question: string, answer: string, approvalId: number): string {
  if (!question.trim() || !answer.trim()) throw new Error("Frage und Antwort duerfen nicht leer sein");
  if (!Number.isInteger(approvalId) || approvalId <= 0) throw new Error(`ungueltige Freigabe-ID: ${approvalId}`);
  const now = new Date().toISOString();
  const { uid } = insertEntry(
    db,
    { kind: "answer", text: `Frage: ${question.trim()}\nAntwort: ${answer.trim()}`, status: "verified", origin: "local", created_at: now, updated_at: now },
    [{ file: `approval/${approvalId}`, lines: String(approvalId), quote: answer.trim(), kind: "approval" }],
  );
  return uid;
}

function load(db: Database, rows: Row[]): MemoryEntry[] {
  return rows.map((r) => ({
    ...r,
    status: r.status as MemoryStatus,
    origin: r.origin as MemoryOrigin,
    evidence: db.query("SELECT file, lines, quote, kind FROM evidence WHERE entry_id = ? ORDER BY rowid").all(r.id) as Evidence[],
  }));
}

function byUid(db: Database, uid: string): MemoryEntry | null {
  const row = db.query(`SELECT ${ENTRY_COLS} FROM entries WHERE uid = ?`).get(uid) as Row | null;
  return row ? load(db, [row])[0]! : null;
}

export function search(db: Database, query: string): MemoryEntry[] {
  // Jedes Wort als Phrase quoten, damit Nutzereingaben keine FTS-Syntax ausloesen.
  const q = query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
  if (!q) return [];
  const rows = db
    .query(`SELECT ${ENTRY_COLS.split(", ").map((c) => `e.${c}`).join(", ")} FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ? ORDER BY rank`)
    .all(q) as Row[];
  return load(db, rows);
}

export function setStatus(db: Database, id: number, status: MemoryStatus): void {
  db.query("UPDATE entries SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
}

function resolveInRoot(root: string, file: string): string {
  const base = resolve(root);
  const full = resolve(base, file);
  const rel = relative(base, full);
  if (isAbsolute(file) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Beleg-Pfad ausserhalb von root: ${file}`);
  }
  return full;
}

const quoteIn = (path: string, quote: string): boolean => {
  try {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n").includes(quote.replace(/\r\n/g, "\n"));
  } catch {
    return false;
  }
};

/** Mechanische Pruefung: jedes Zitat muss woertlich in der Datei unter `root` stehen. Setzt dann verified. */
export function verifyEntry(db: Database, id: number, root: string): boolean {
  const ev = db.query("SELECT file, quote FROM evidence WHERE entry_id = ? AND kind = 'file'").all(id) as Evidence[];
  if (ev.length === 0) return false;
  const paths = ev.map((e) => resolveInRoot(root, e.file));
  const ok = ev.every((e, i) => quoteIn(paths[i]!, e.quote));
  if (ok) setStatus(db, id, "verified");
  return ok;
}

/**
 * Erneute Zitatpruefung eines Eintrags (z. B. vor Nutzung als Beleg). Liefert null, wenn alle
 * Datei-Belege noch stimmen, sonst eine Meldung; der Eintrag wird dann `stale`.
 * Freigabe-Belege (`approval`) gelten ohne Datei als gueltig.
 */
export function checkMemoryEvidence(db: Database, uid: string, root: string): string | null {
  const entry = byUid(db, uid);
  if (!entry) return `Memory-Eintrag ${uid} unbekannt`;
  for (const e of entry.evidence) {
    if (e.kind === "approval") continue;
    let path: string;
    try {
      path = resolveInRoot(root, e.file);
    } catch (err) {
      setStatus(db, entry.id!, "stale");
      return `Memory-Eintrag ${uid}: ${(err as Error).message}`;
    }
    if (!quoteIn(path, e.quote)) {
      setStatus(db, entry.id!, "stale");
      return `Memory-Eintrag ${uid}: Zitat nicht mehr in ${e.file}:${e.lines}`;
    }
  }
  return null;
}

function toMarkdown(e: MemoryEntry): string {
  return [
    "---",
    `uid: ${e.uid}`,
    `kind: ${e.kind}`,
    `status: ${e.status}`,
    `updated: ${e.updated_at ?? e.created_at}`,
    "---",
    "",
    e.text,
    "",
    "## Belege",
    ...e.evidence.map((v) => `- ${v.file}:${v.lines}\n  > ${v.quote.replace(/\n/g, "\n  > ")}`),
    "",
  ].join("\n");
}

const fileName = (kind: string, uid: string) => `${kind.replace(/[^\w-]/g, "_")}-${uid}.md`;

/**
 * Schreibt je verified-Eintrag `<kind>-<uid>.md` nach outDir. Eintraege mit Freigabe-Beleg bleiben lokal.
 * Entfernt nur Dateien eigener, nicht mehr exportierter Eintraege und Dateien im alten Muster `<kind>-<id>.md`
 * (alte Exporte werden nie importiert). Dateien fremder Rechner bleiben: unbekannte UID, importierte Eintraege
 * (Herkunft `remote`) und UIDs mit erkanntem Abgleich-Konflikt. Sonstige Dateien bleiben. Liefert die Anzahl.
 */
export function exportVerified(db: Database, outDir: string): number {
  const rows = db
    .query(`SELECT ${ENTRY_COLS} FROM entries e WHERE status = 'verified'
      AND NOT EXISTS (SELECT 1 FROM evidence v WHERE v.entry_id = e.id AND v.kind = 'approval') ORDER BY id`)
    .all() as Row[];
  mkdirSync(outDir, { recursive: true });
  const names = new Set<string>();
  for (const e of load(db, rows)) {
    const name = fileName(e.kind, e.uid!);
    names.add(name);
    writeFileSync(join(outDir, name), toMarkdown(e));
  }
  const known = db.query(`SELECT 1 FROM entries WHERE uid = ?1 AND origin = 'local'
    AND NOT EXISTS (SELECT 1 FROM memory_conflicts WHERE uid = ?1)`);
  for (const f of readdirSync(outDir)) {
    if (names.has(f)) continue;
    if (EXPORT_FILE.test(f)) {
      if (known.get(f.slice(-19, -3))) rmSync(join(outDir, f));
    } else if (LEGACY_EXPORT_FILE.test(f)) {
      rmSync(join(outDir, f));
    }
  }
  return rows.length;
}

/** Liest eine exportierte Datei; null bei fremdem oder kaputtem Inhalt. */
function parseExport(md: string, uidFromName: string): MemoryEntry | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const head: Record<string, string> = {};
  for (const l of lines.slice(1, end)) {
    const m = /^(\w+): (.*)$/.exec(l);
    if (m) head[m[1]!] = m[2]!;
  }
  const { uid, kind, status, updated } = head;
  if (!uid || uid !== uidFromName || !kind || !updated || !STATUSES.includes(status as MemoryStatus)) return null;
  const belege = lines.lastIndexOf("## Belege");
  if (belege < end + 2 || lines[end + 1] !== "" || lines[belege - 1] !== "") return null;
  const text = lines.slice(end + 2, belege - 1).join("\n");
  const items: Array<{ file: string; lines: string; quote: string[] }> = [];
  for (const l of lines.slice(belege + 1)) {
    const item = /^- (.+):(\d+(?:-\d+)?)$/.exec(l);
    const quote = /^ {2}>(?: (.*))?$/.exec(l);
    if (item) items.push({ file: item[1]!, lines: item[2]!, quote: [] });
    else if (quote && items.length > 0) items[items.length - 1]!.quote.push(quote[1] ?? "");
    else if (l.trim() !== "") return null;
  }
  const evidence: Evidence[] = items.map((i) => ({ file: i.file, lines: i.lines, quote: i.quote.join("\n"), kind: "file" }));
  try {
    validateFileEvidence(evidence);
  } catch {
    return null;
  }
  return { uid, kind, text, status: status as MemoryStatus, origin: "remote", created_at: updated, updated_at: updated, evidence };
}

function lineRange(lines: string): [number, number] | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return [Math.min(a, b), Math.max(a, b)];
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Lokaler verified-Eintrag, dessen Datei-Beleg sich mit einem Beleg des fernen Eintrags ueberschneidet. */
function anchorClash(db: Database, remote: MemoryEntry): MemoryEntry | null {
  if (remote.status !== "verified") return null;
  const rows = db
    .query(`SELECT DISTINCT ${ENTRY_COLS.split(", ").map((c) => `e.${c}`).join(", ")} FROM entries e JOIN evidence v ON v.entry_id = e.id
      WHERE e.status = 'verified' AND v.kind = 'file' ORDER BY e.id`)
    .all() as Row[];
  for (const local of load(db, rows)) {
    if (local.text === remote.text) continue;
    const hit = local.evidence.some((l) => {
      if (l.kind !== "file") return false;
      const lr = lineRange(l.lines);
      return remote.evidence.some((r) => {
        const rr = lineRange(r.lines);
        return !!lr && !!rr && normPath(l.file) === normPath(r.file) && lr[0] <= rr[1] && rr[0] <= lr[1];
      });
    });
    if (hit) return local;
  }
  return null;
}

function insertRemote(db: Database, remote: MemoryEntry): boolean {
  return insertEntry(
    db,
    {
      kind: remote.kind,
      text: remote.text,
      status: remote.status ?? "proposed",
      origin: "remote",
      created_at: remote.created_at ?? new Date().toISOString(),
      updated_at: remote.updated_at ?? remote.created_at ?? new Date().toISOString(),
    },
    remote.evidence.map((v) => ({ ...v, kind: "file" })),
  ).created;
}

/**
 * Importiert exportierte Eintraege (`<kind>-<uid>.md`) aus dir mit Herkunft `remote`.
 * Unbekannte oder kaputte Dateien werden uebersprungen. Gleiche UID mit anderem Status oder
 * ueberlappender Beleg-Anker mit anderem Text ergeben Konflikte; lokale Eintraege bleiben dabei unveraendert.
 */
export function importEntries(db: Database, dir: string): { imported: number; conflicts: MemoryConflict[] } {
  let imported = 0;
  const conflicts: MemoryConflict[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!EXPORT_FILE.test(f)) continue;
    let md: string;
    try {
      md = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const remote = parseExport(md, f.slice(-19, -3));
    if (!remote) continue;
    const local = byUid(db, remote.uid!);
    if (local) {
      if (local.status !== remote.status) conflicts.push({ uid: remote.uid!, reason: "status", local, remote });
      continue;
    }
    const clash = anchorClash(db, remote);
    if (clash) {
      conflicts.push({ uid: remote.uid!, reason: "anchor", local: clash, remote });
      continue;
    }
    if (insertRemote(db, remote)) imported++;
  }
  return { imported, conflicts };
}

/**
 * Loest einen Konflikt auf.
 * - status: `remote` uebernimmt den fernen Status, `local` und `both` behalten den lokalen Eintrag (gleiche UID).
 * - anchor: `local` verwirft den fernen Eintrag, `remote` setzt den lokalen auf stale und uebernimmt den fernen,
 *   `both` uebernimmt den fernen zusaetzlich.
 */
export function resolveConflict(db: Database, c: MemoryConflict, choice: "local" | "remote" | "both"): void {
  if (choice === "local") return;
  const local = byUid(db, c.local.uid ?? c.uid);
  if (c.reason === "status") {
    if (choice === "remote" && local && c.remote.status) setStatus(db, local.id!, c.remote.status);
    return;
  }
  db.transaction(() => {
    if (choice === "remote" && local) setStatus(db, local.id!, "stale");
    if (!byUid(db, c.remote.uid ?? memoryUid(c.remote.kind, c.remote.text))) insertRemote(db, c.remote);
  })();
}
