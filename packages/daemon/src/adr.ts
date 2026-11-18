import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-Verwaltung im Ziel-Projekt (ADR 0006, Baustein ADR-Verwaltung).
 * ADRs liegen als `NNNN-<slug>.md` in einem Ordner; Kopfzeile `# ADR NNNN: Titel`,
 * darunter eine Zeile `Status: …` (auch `Status: **Entwurf** (…)`).
 */
export type AdrStatus = "entwurf" | "angenommen" | "abgelehnt" | "abgeloest";

export type AdrInfo = {
  number: number;
  title: string;
  status: AdrStatus;
  path: string;
  supersededBy?: number;
  openQuestions: string[];
};

const FILE_RE = /^(\d{4})-.*\.md$/;
const TITLE_RE = /^#\s+ADR\s+(\d+)\s*:\s*(.+?)\s*$/;
const STATUS_RE = /^\s*\**\s*Status\s*\**\s*:\s*\**\s*(.*)$/i;
const SUPERSEDED_RE = /(?:durch|by)\s+ADR\s+0*(\d+)/i;

const pad = (n: number) => String(n).padStart(4, "0");

/** Status-Text (ohne Markdown) auf den festen Wertebereich abbilden; Unbekanntes gilt als Entwurf. */
function parseStatus(raw: string): AdrStatus {
  const s = raw.replace(/\*/g, "").trim().toLowerCase();
  if (/^(angenommen|accepted)/.test(s)) return "angenommen";
  if (/^(abgelehnt|rejected)/.test(s)) return "abgelehnt";
  if (/^(abgelöst|abgeloest|superseded)/.test(s)) return "abgeloest";
  return "entwurf";
}

/** Aufzaehlungspunkte aus Abschnitten, deren Ueberschrift „offen“ enthaelt (z. B. „Offene Fragen“). */
function openQuestions(lines: string[]): string[] {
  const out: string[] = [];
  let level = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const l = h[1]!.length;
      if (level && l <= level) level = 0;
      if (!level && l >= 2 && /\boffen/i.test(h[2]!)) level = l;
      continue;
    }
    if (!level) continue;
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (item) out.push(item[1]!.trim());
  }
  return out;
}

/** Liest alle ADRs eines Ordners, sortiert nach Nummer. Fehlt der Ordner, ist die Liste leer. */
export function listAdrs(dir: string): AdrInfo[] {
  if (!existsSync(dir)) return [];
  const out: AdrInfo[] = [];
  for (const f of readdirSync(dir)) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const path = join(dir, f);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    let number = Number(m[1]);
    let title = f.replace(/^\d{4}-/, "").replace(/\.md$/, "");
    let status: AdrStatus = "entwurf";
    let supersededBy: number | undefined;
    let seenTitle = false;
    let seenStatus = false;
    for (const line of lines) {
      const t = !seenTitle && TITLE_RE.exec(line);
      if (t) {
        seenTitle = true;
        number = Number(t[1]);
        title = t[2]!;
        continue;
      }
      const s = !seenStatus && STATUS_RE.exec(line);
      if (s) {
        seenStatus = true;
        status = parseStatus(s[1]!);
        const sup = SUPERSEDED_RE.exec(s[1]!);
        if (status === "abgeloest" && sup) supersededBy = Number(sup[1]);
      }
    }
    out.push({ number, title, status, path, ...(supersededBy !== undefined ? { supersededBy } : {}), openQuestions: openQuestions(lines) });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** ASCII-Slug: Umlaute ausgeschrieben, Akzente entfernt, sonst nur a-z, 0-9 und Bindestriche. */
export function adrSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "adr";
}

/** Legt ein neues ADR mit der naechsten freien Nummer an (Status Entwurf) und gibt den Pfad zurueck. */
export function createAdr(dir: string, title: string, today: string): string {
  mkdirSync(dir, { recursive: true });
  const used = readdirSync(dir)
    .map((f) => FILE_RE.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  const n = used.length ? Math.max(...used) + 1 : 1;
  const path = join(dir, `${pad(n)}-${adrSlug(title)}.md`);
  const text = [
    `# ADR ${pad(n)}: ${title}`,
    "",
    "Status: Entwurf",
    `Datum: ${today}`,
    "",
    "## Kontext",
    "",
    "## Entscheidung",
    "",
    "## Folgen",
    "",
    "## Offene Fragen",
    "",
  ].join("\n");
  writeFileSync(path, text);
  return path;
}

const STATUS_LABEL: Record<AdrStatus, string> = {
  entwurf: "Entwurf",
  angenommen: "angenommen",
  abgelehnt: "abgelehnt",
  abgeloest: "abgelöst",
};

/** Setzt die Status-Zeile; bei Abloesung mit `supersededBy` als `abgelöst durch ADR NNNN`. */
export function setAdrStatus(path: string, status: AdrStatus, supersededBy?: number): void {
  const text = readFileSync(path, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let label = STATUS_LABEL[status];
  if (status === "abgeloest" && supersededBy !== undefined) label += ` durch ADR ${pad(supersededBy)}`;
  const line = `Status: ${label}`;
  const idx = lines.findIndex((l) => STATUS_RE.test(l));
  if (idx >= 0) lines[idx] = line;
  else {
    const t = lines.findIndex((l) => TITLE_RE.test(l));
    lines.splice(t + 1, 0, "", line);
  }
  writeFileSync(path, lines.join(eol));
}
