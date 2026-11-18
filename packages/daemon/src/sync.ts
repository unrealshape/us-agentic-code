import type { Database } from "bun:sqlite";
import type { Actor } from "@usac/shared";
import type { GitRunner } from "./integrator";
import { importEntries, resolveConflict, type MemoryConflict, type MemoryEntry } from "./memory";
import type { Store } from "./store";

/**
 * Team-Abgleich des Memory ueber das Git-Repo `usac-memory`.
 * Holt nur (`git pull --ff-only`) und importiert; committet und pusht nie.
 * Konflikte landen als Freigabe `memory_conflict` in der Inbox. Jede Entscheidung wird in der
 * Memory-DB (Tabelle `memory_conflicts`, je Fingerabdruck) gespeichert, damit derselbe Konflikt
 * beim naechsten Abgleich nicht erneut gemeldet wird.
 */

export type ConflictChoice = "local" | "remote" | "both";
export const MEMORY_CONFLICT = "memory_conflict";
const TRACE = "memory";
const PROJECT = "usac-memory";

function emit(store: Store, type: string, data: unknown, actor: Actor = "orchestrator"): void {
  store.append({ traceId: TRACE, spanId: TRACE, parentSpanId: null, project: PROJECT, type, actor, data });
}

const sortedEvidence = (e: MemoryEntry) =>
  e.evidence.map((v) => [v.file, v.lines, v.quote, v.kind ?? "file"].join("\u0000")).sort();

/**
 * Fingerabdruck eines Konflikts: aendert sich, sobald der ferne Stand (Status, Zeitstempel, Belege)
 * oder der lokale Status sich aendert. Dann wird erneut gefragt.
 */
export function conflictFingerprint(c: MemoryConflict): string {
  const key = JSON.stringify([
    c.reason,
    c.local.uid,
    c.local.status,
    c.remote.uid ?? c.uid,
    c.remote.status,
    c.remote.updated_at,
    sortedEvidence(c.remote),
  ]);
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

export async function pullMemory(opts: { dir: string; db: Database; store: Store; git: GitRunner }): Promise<{
  imported: number;
  conflicts: number;
  approvalIds: number[];
}> {
  const { dir, db, store, git } = opts;
  const r = await git(dir, ["pull", "--ff-only"]);
  if (r.exitCode !== 0) throw new Error(`git pull --ff-only fehlgeschlagen: ${r.output.trim()}`);
  const res = importEntries(db, dir);
  const known = db.query("SELECT approval_id, choice FROM memory_conflicts WHERE fingerprint = ?");
  const approvalIds: number[] = [];
  let open = 0;
  for (const c of res.conflicts) {
    const fp = conflictFingerprint(c);
    const row = known.get(fp) as { approval_id: number; choice: string | null } | null;
    if (row) {
      // Schon gemeldet: entschieden -> still uebergehen, offen -> zaehlt, aber keine neue Freigabe.
      if (row.choice === null) open++;
      continue;
    }
    const a = store.createApproval(TRACE, MEMORY_CONFLICT, { uid: c.uid, reason: c.reason, local: c.local, remote: c.remote, fingerprint: fp });
    db.query("INSERT INTO memory_conflicts(fingerprint, uid, reason, approval_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      fp,
      c.uid,
      c.reason,
      a.id,
      new Date().toISOString(),
    );
    approvalIds.push(a.id);
    open++;
    emit(store, "memory.conflict", { uid: c.uid, reason: c.reason });
  }
  emit(store, "memory.pulled", { imported: res.imported, conflicts: open });
  return { imported: res.imported, conflicts: open, approvalIds };
}

/** Notiz der Freigabe -> Wahl. Abgelehnt oder unbekannte Notiz = `local` (nichts aendert sich). */
function choiceOf(status: "granted" | "denied", note: string | null): ConflictChoice {
  if (status === "denied") return "local";
  const n = (note ?? "").trim().toLowerCase();
  if (n === "remote") return "remote";
  if (n === "beide" || n === "both") return "both";
  return "local";
}

/** Wendet erledigte Freigaben `memory_conflict` an und speichert die Wahl. Liefert die Anzahl. */
export function applyConflictDecisions(db: Database, store: Store): number {
  const rows = db.query("SELECT fingerprint, approval_id FROM memory_conflicts WHERE choice IS NULL ORDER BY approval_id").all() as Array<{
    fingerprint: string;
    approval_id: number;
  }>;
  let applied = 0;
  for (const row of rows) {
    const a = store.getApproval(row.approval_id);
    if (!a || a.kind !== MEMORY_CONFLICT || a.status === "pending") continue;
    const ctx = a.context as { uid: string; reason: MemoryConflict["reason"]; local: MemoryEntry; remote: MemoryEntry };
    const choice = choiceOf(a.status, a.note);
    db.transaction(() => {
      resolveConflict(db, { uid: ctx.uid, reason: ctx.reason, local: ctx.local, remote: ctx.remote }, choice);
      db.query("UPDATE memory_conflicts SET choice = ?, decided_at = ? WHERE fingerprint = ?").run(choice, new Date().toISOString(), row.fingerprint);
    })();
    emit(store, "memory.conflict_resolved", { uid: ctx.uid, choice });
    applied++;
  }
  return applied;
}
