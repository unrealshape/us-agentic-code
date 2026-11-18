import type { Database } from "bun:sqlite";
import type { InstinctProposal } from "@usac/shared";

/**
 * Instincts: kurze, belegte Verhaltensregeln je Rolle, gelernt aus Problemen frueherer Laeufe.
 * Lebenszyklus: proposed -> (Freigabe `instinct`) -> active -> retired.
 * Alle Schwellen sind Konstanten im Code; kein LLM entscheidet ueber Aktivierung oder Stilllegung.
 */

export type InstinctStatus = "proposed" | "active" | "retired";

export interface Instinct {
  id: number;
  uid: string;
  text: string;
  role: string;
  glob: string | null;
  status: InstinctStatus;
  event_ids: number[];
  uses: number;
  recurrences: number;
  created_at: string;
  activated_at: string | null;
  retired_at: string | null;
  retire_reason: string | null;
}

/** Hoechstens so viele aktive Instincts landen in einem Prompt. */
export const MAX_ACTIVE_IN_PROMPT = 10;
/** Stilllegung fruehestens nach so vielen Nutzungen ... */
export const RETIRE_MIN_USES = 5;
/** ... wenn der Fehler mindestens so oft wiederkehrte ... */
export const RETIRE_MIN_RECURRENCES = 3;
/** ... und mindestens in diesem Anteil der Nutzungen. */
export const RETIRE_MIN_RATIO = 0.5;
export const RETIRE_INEFFECTIVE = "wirkungslos";

const COLS = "id, uid, text, role, glob, status, event_ids, uses, recurrences, created_at, activated_at, retired_at, retire_reason";
type Row = Omit<Instinct, "event_ids" | "status"> & { event_ids: string; status: string };

const ensured = new WeakSet<Database>();

/** Legt die Tabelle `instincts` in memory.db an (idempotent). */
export function ensureInstincts(db: Database): void {
  if (ensured.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS instincts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    role TEXT NOT NULL,
    glob TEXT,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
    event_ids TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    recurrences INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    retired_at TEXT,
    retire_reason TEXT
  )`);
  ensured.add(db);
}

/** Inhaltsbasierte ID: erste 16 Hex-Zeichen von SHA-256 ueber Rolle, Glob und Text. */
export function instinctUid(role: string, glob: string | undefined | null, text: string): string {
  return new Bun.CryptoHasher("sha256").update(`${role}\n${glob ?? ""}\n${text}`).digest("hex").slice(0, 16);
}

const toInstinct = (r: Row): Instinct => ({ ...r, status: r.status as InstinctStatus, event_ids: JSON.parse(r.event_ids) as number[] });

export function getInstinct(db: Database, id: number): Instinct | null {
  ensureInstincts(db);
  const r = db.query(`SELECT ${COLS} FROM instincts WHERE id = ?`).get(id) as Row | null;
  return r ? toInstinct(r) : null;
}

export function listInstincts(db: Database, status?: InstinctStatus): Instinct[] {
  ensureInstincts(db);
  const rows = (status
    ? db.query(`SELECT ${COLS} FROM instincts WHERE status = ? ORDER BY id`).all(status)
    : db.query(`SELECT ${COLS} FROM instincts ORDER BY id`).all()) as Row[];
  return rows.map(toInstinct);
}

/**
 * Legt einen Vorschlag (`proposed`) an. Jeder Beleg muss ein existierendes Ereignis sein,
 * sonst wird abgelehnt. Gleicher Vorschlag (Rolle, Glob, Text) liefert die bestehende ID.
 */
export function proposeInstinct(db: Database, p: InstinctProposal, eventExists: (id: number) => boolean): number {
  ensureInstincts(db);
  const text = p.text?.trim() ?? "";
  const role = p.role?.trim() ?? "";
  if (!text || !role) throw new Error("Instinct-Vorschlag ohne Text oder Rolle abgelehnt");
  const ids = [...new Set(p.event_ids ?? [])];
  if (ids.length === 0) throw new Error("Instinct-Vorschlag ohne Ereignis-Beleg abgelehnt");
  const missing = ids.filter((id) => !Number.isInteger(id) || id <= 0 || !eventExists(id));
  if (missing.length) throw new Error(`Instinct-Vorschlag abgelehnt: Ereignis(se) ${missing.join(", ")} nicht vorhanden`);
  const glob = p.glob?.trim() || null;
  const uid = instinctUid(role, glob, text);
  const existing = db.query("SELECT id FROM instincts WHERE uid = ?").get(uid) as { id: number } | null;
  if (existing) return existing.id;
  const r = db
    .query("INSERT INTO instincts(uid, text, role, glob, status, event_ids, created_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?)")
    .run(uid, text, role, glob, JSON.stringify(ids), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function requireInstinct(db: Database, id: number): Instinct {
  const i = getInstinct(db, id);
  if (!i) throw new Error(`Instinct ${id} unbekannt`);
  return i;
}

/** Nach erteilter Freigabe: `proposed` -> `active`. Stillgelegte bleiben stillgelegt. */
export function activateInstinct(db: Database, id: number): void {
  const i = requireInstinct(db, id);
  if (i.status === "retired") throw new Error(`Instinct ${id} ist stillgelegt (${i.retire_reason})`);
  if (i.status === "active") return;
  db.query("UPDATE instincts SET status = 'active', activated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function retireInstinct(db: Database, id: number, reason: string): void {
  const i = requireInstinct(db, id);
  if (!reason.trim()) throw new Error("Stilllegung ohne Grund abgelehnt");
  if (i.status === "retired") return;
  db.query("UPDATE instincts SET status = 'retired', retired_at = ?, retire_reason = ? WHERE id = ?").run(new Date().toISOString(), reason.trim(), id);
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Aktive Instincts einer Rolle, deren Glob (falls gesetzt) auf eine der Dateien passt; neueste zuerst. */
export function activeInstincts(db: Database, role: string, files: string[]): Instinct[] {
  ensureInstincts(db);
  const rows = db
    .query(`SELECT ${COLS} FROM instincts WHERE status = 'active' AND role = ? ORDER BY activated_at DESC, id DESC`)
    .all(role) as Row[];
  const paths = files.map(normPath);
  const out: Instinct[] = [];
  for (const r of rows) {
    if (r.glob) {
      const g = new Bun.Glob(r.glob);
      if (!paths.some((f) => g.match(f))) continue;
    }
    out.push(toInstinct(r));
    if (out.length >= MAX_ACTIVE_IN_PROMPT) break;
  }
  return out;
}

/**
 * Zaehlt fuer die in einem Lauf genutzten Instincts eine Nutzung (und ggf. eine Wiederholung
 * des Fehlers). Liefert die IDs, die dabei als wirkungslos stillgelegt wurden.
 */
export function recordOutcome(db: Database, ids: number[], recurred: boolean): number[] {
  ensureInstincts(db);
  const retired: number[] = [];
  db.transaction(() => {
    for (const id of new Set(ids)) {
      const i = getInstinct(db, id);
      if (!i || i.status !== "active") continue;
      const uses = i.uses + 1;
      const recurrences = i.recurrences + (recurred ? 1 : 0);
      db.query("UPDATE instincts SET uses = ?, recurrences = ? WHERE id = ?").run(uses, recurrences, id);
      if (uses >= RETIRE_MIN_USES && recurrences >= RETIRE_MIN_RECURRENCES && recurrences / uses >= RETIRE_MIN_RATIO) {
        retireInstinct(db, id, RETIRE_INEFFECTIVE);
        retired.push(id);
      }
    }
  })();
  return retired;
}
