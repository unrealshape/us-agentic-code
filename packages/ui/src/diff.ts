/**
 * Eigener Parser und Renderer fuer Unified Diffs (Plan-Entscheidung: keine Bibliothek).
 * Alle Texte aus dem Diff und aus Befunden gehen durch `esc`.
 */
import type { Evidence } from "../../shared/src/index";
import { esc } from "./html";

export type DiffLine = { kind: "add" | "del" | "ctx"; oldNo?: number; newNo?: number; text: string };
export type FileDiff = { path: string; hunks: { header: string; lines: DiffLine[] }[] };
export type ReviewFinding = { severity: string; text: string; evidence: Evidence[] };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Entfernt Git-Anfuehrungszeichen (`"a/x y"`). */
function unquote(raw: string): string {
  if (!(raw.length > 1 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  return raw.slice(1, -1).replace(/\\(["\\tn])/g, (_m, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

/** Pfad aus `---`/`+++`/`diff --git` ohne Praefix `a/` bzw. `b/`; `/dev/null` ergibt null. */
function cleanPath(raw: string): string | null {
  const p = unquote(raw.replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * Zerlegt die Ausgabe von `git diff` in Dateien und Hunks. Das Ende eines Hunks ergibt sich aus
 * den Zeilenzahlen im Kopf; daher werden Inhaltszeilen wie `--- x` nicht als Dateikopf gelesen.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let pendingOld: string | null = null;

  const start = (path: string) => {
    cur = { path, hunks: [] };
    files.push(cur);
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = cur ? (cur as FileDiff).hunks.at(-1) : undefined;
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === "+") {
        hunk.lines.push({ kind: "add", newNo: newNo++, text: body });
        newLeft--;
        continue;
      }
      if (tag === "-") {
        hunk.lines.push({ kind: "del", oldNo: oldNo++, text: body });
        oldLeft--;
        continue;
      }
      if (tag === " " || line === "") {
        hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: body });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (tag === "\\") continue; // "\ No newline at end of file"
      // Unerwartete Zeile: Hunk gilt als beendet, Kopfzeilen weiter unten auswerten.
      oldLeft = newLeft = 0;
    }
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      start((m && (cleanPath(m[2]!) ?? cleanPath(m[1]!))) ?? line.slice(11));
      pendingOld = null;
      continue;
    }
    if (line.startsWith("rename to ") && cur) {
      (cur as FileDiff).path = unquote(line.slice(10));
      continue;
    }
    if (line.startsWith("--- ")) {
      pendingOld = line.slice(4);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = cleanPath(line.slice(4)) ?? (pendingOld !== null ? cleanPath(pendingOld) : null) ?? "";
      if (!cur || (cur as FileDiff).hunks.length) start(path);
      else (cur as FileDiff).path = path;
      pendingOld = null;
      continue;
    }
    const m = HUNK.exec(line);
    if (m && cur) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      // Bei leerer Seite (z. B. -0,0) beginnt die Zaehlung bei 1.
      if (oldLeft === 0 && oldNo === 0) oldNo = 1;
      if (newLeft === 0 && newNo === 0) newNo = 1;
      (cur as FileDiff).hunks.push({ header: line, lines: [] });
    }
  }
  return files;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function findingHtml(f: ReviewFinding): string {
  return `<div class="finding sev-${esc(f.severity)}"><strong>[${esc(f.severity)}]</strong> ${esc(f.text)}</div>`;
}

/**
 * Rendert die Dateien als Tabellen. Ein Befund mit Datei-Beleg erscheint direkt nach der letzten
 * neuen Zeile seines Zeilenbereichs; Befunde ohne passende Zeile stehen oberhalb des Diffs.
 */
export function renderDiff(files: FileDiff[], findings: ReviewFinding[]): string {
  // Schluessel "pfad\0newNo" -> Befunde, die nach dieser Zeile erscheinen.
  const anchored = new Map<string, ReviewFinding[]>();
  const placed = new Set<ReviewFinding>();
  for (const f of findings) {
    for (const ev of f.evidence) {
      if (ev.type !== "file") continue;
      const path = normPath(ev.path);
      const [from, to] = ev.lines;
      let target: number | undefined;
      for (const file of files) {
        if (normPath(file.path) !== path) continue;
        for (const h of file.hunks)
          for (const l of h.lines) if (l.newNo !== undefined && l.newNo >= from && l.newNo <= to) target = Math.max(target ?? 0, l.newNo);
      }
      if (target === undefined) continue;
      const key = `${path}\0${target}`;
      const list = anchored.get(key) ?? [];
      if (!list.includes(f)) list.push(f);
      anchored.set(key, list);
      placed.add(f);
    }
  }

  const loose = findings.filter((f) => !placed.has(f));
  const looseHtml = loose.length
    ? `<section class="findings"><h3>Befunde ohne Diff-Zeile</h3>${loose.map(findingHtml).join("")}</section>`
    : "";

  const sign = { add: "+", del: "-", ctx: " " } as const;
  const filesHtml = files
    .map((file) => {
      const path = normPath(file.path);
      const rows = file.hunks
        .map((h) => {
          const head = `<tr class="hunk"><td colspan="3">${esc(h.header)}</td></tr>`;
          const body = h.lines
            .map((l) => {
              const row =
                `<tr class="${l.kind}"><td class="no">${l.oldNo ?? ""}</td><td class="no">${l.newNo ?? ""}</td>` +
                `<td><pre>${sign[l.kind]}${esc(l.text)}</pre></td></tr>`;
              const attached = l.newNo !== undefined ? anchored.get(`${path}\0${l.newNo}`) : undefined;
              return attached ? row + `<tr class="findings"><td colspan="3">${attached.map(findingHtml).join("")}</td></tr>` : row;
            })
            .join("");
          return head + body;
        })
        .join("");
      return `<section class="file"><h3>${esc(file.path)}</h3><table class="diff">${rows}</table></section>`;
    })
    .join("");
  return looseHtml + filesHtml;
}
