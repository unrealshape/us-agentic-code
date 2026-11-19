// Nachtbetrieb: Zeitfenster (lokale Zeit, ueber Mitternacht erlaubt), Token-Budget je Nacht
// und Morgenbericht. Alle Funktionen sind rein; der Scheduler entscheidet damit.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { UsacEvent } from "@usac/shared";

export const NightConfig = z.object({
  window: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/).default("22:00-06:00"),
  max_tokens: z.number().int().positive().default(2_000_000),
  max_parallel: z.number().int().min(1).max(3).default(3),
});
export type NightConfig = z.infer<typeof NightConfig>;

/** Liest `<home>/config.yaml`, Schluessel `night`. Fehlt Datei oder Schluessel, gelten die Standardwerte. */
export function loadNightConfig(home: string): NightConfig {
  const p = join(home, "config.yaml");
  if (!existsSync(p)) return NightConfig.parse({});
  const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as { night?: unknown };
  return NightConfig.parse(raw.night ?? {});
}

/** Fenster als Minuten seit Mitternacht. Ungueltige Uhrzeiten werfen einen Fehler. */
function parseWindow(window: string): { start: number; end: number } {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) throw new Error(`Ungueltiges Nachtfenster: ${window}`);
  const [sh = 0, sm = 0, eh = 0, em = 0] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) throw new Error(`Ungueltiges Nachtfenster: ${window}`);
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

/** Ob `now` (lokale Zeit) im Fenster liegt. Beginn inklusive, Ende exklusiv. Gleiche Start- und Endzeit ergibt ein leeres Fenster. */
export function isInWindow(now: Date, window: string): boolean {
  const { start, end } = parseWindow(window);
  const m = now.getHours() * 60 + now.getMinutes();
  if (start < end) return m >= start && m < end;
  if (start > end) return m >= start || m < end;
  return false;
}

/** Letzter Beginn des Fensters, der nicht nach `now` liegt (lokale Zeit). */
export function windowStart(now: Date, window: string): Date {
  const { start } = parseWindow(window);
  const sh = Math.floor(start / 60);
  const sm = start % 60;
  const m = now.getHours() * 60 + now.getMinutes();
  const daysBack = m >= start ? 0 : 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, sh, sm);
}

/** Ende des Fensters, das um `since` beginnt (lokale Zeit, Ende exklusiv). */
export function windowEnd(since: Date, window: string): Date {
  const { start, end } = parseWindow(window);
  const endDayOffset = end <= start ? 1 : 0;
  return new Date(since.getFullYear(), since.getMonth(), since.getDate() + endDayOffset, Math.floor(end / 60), end % 60);
}

function tokensOf(ev: UsacEvent): number {
  const t = (ev.data as { tokens?: { input?: number; output?: number } } | null)?.tokens;
  return (Number(t?.input) || 0) + (Number(t?.output) || 0);
}

/** Summe der Tokens aus `run.finished` seit `since` (Eingabe plus Ausgabe, wie quota.ts). */
export function nightTokensUsed(events: UsacEvent[], since: Date): number {
  const sinceMs = since.getTime();
  let used = 0;
  for (const ev of events) {
    if (ev.type !== "run.finished") continue;
    if (new Date(ev.ts).getTime() < sinceMs) continue;
    used += tokensOf(ev);
  }
  return used;
}

/**
 * Morgenbericht fuer [since, until): erledigte, eskalierte und auf Freigabe wartende Auftraege
 * (Reihenfolge wie im Event-Log, ohne Dubletten) sowie verbrauchte Tokens.
 * "Wartend" heisst: letztes Freigabe-Ereignis des Auftrags im Zeitraum ist `approval.requested`.
 */
export function nightReport(events: UsacEvent[], since: Date, until: Date): { done: string[]; escalated: string[]; waiting: string[]; tokens: number } {
  const s = since.getTime();
  const u = until.getTime();
  const inRange = events.filter((e) => {
    const t = new Date(e.ts).getTime();
    return t >= s && t < u;
  });
  const done = new Set<string>();
  const escalated = new Set<string>();
  const lastApproval = new Map<string, string>();
  let tokens = 0;
  for (const e of inRange) {
    switch (e.type) {
      case "workitem.done":
        done.add(e.traceId);
        break;
      case "workitem.escalated":
        escalated.add(e.traceId);
        break;
      case "approval.requested":
      case "approval.granted":
      case "approval.denied":
      case "approval.resolved":
        lastApproval.set(e.traceId, e.type);
        break;
      case "run.finished":
        tokens += tokensOf(e);
        break;
    }
  }
  const waiting = [...lastApproval].filter(([, type]) => type === "approval.requested").map(([id]) => id);
  return { done: [...done], escalated: [...escalated], waiting, tokens };
}
