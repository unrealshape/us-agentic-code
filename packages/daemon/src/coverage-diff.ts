/**
 * Coverage-Diff (Gate-Stufe 5): misst die Abdeckung nur der geaenderten Zeilen.
 * Quelle der Abdeckung ist eine lcov-Datei (`SF:`/`DA:`), Quelle der Aenderungen `git diff -U0`.
 */
import { git } from "./exec";

export const DEFAULT_COVERAGE_THRESHOLD = 0.8;

export interface CoverageDiffResult {
  covered: number;
  total: number;
  ratio: number;
  uncovered: { file: string; lines: number[] }[];
}

/** Vereinheitlicht Trenner auf `/` und entfernt abschliessende `/`. */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Pfad relativ zu `root` mit `/`; liegt er nicht unter `root`, bleibt er (normalisiert) erhalten. */
function relativeTo(file: string, root: string): string {
  const f = normalize(file);
  const r = normalize(root);
  if (r === "") return f.replace(/^\.\//, "");
  // Laufwerksbuchstaben unter Windows ohne Ruecksicht auf Gross-/Kleinschreibung vergleichen.
  const prefix = r + "/";
  if (f.startsWith(prefix)) return f.slice(prefix.length);
  if (/^[A-Za-z]:/.test(r) && f.toLowerCase().startsWith(prefix.toLowerCase())) return f.slice(prefix.length);
  return f.replace(/^\.\//, "");
}

/** Liest lcov-Text: Datei (relativ zu `root`) → Zeile → Treffer. */
export function parseLcov(text: string, root: string): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const file = relativeTo(line.slice(3), root);
      current = result.get(file) ?? new Map<number, number>();
      result.set(file, current);
    } else if (line.startsWith("DA:") && current) {
      const [ln, hits] = line.slice(3).split(",");
      const n = Number(ln);
      const h = Number(hits);
      if (Number.isInteger(n) && Number.isFinite(h)) current.set(n, (current.get(n) ?? 0) + h);
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return result;
}

/** Entfernt Git-Quoting (`"pfad mit \"x\""`) und das Praefix `b/`. */
function diffPath(raw: string): string | undefined {
  let p = raw.trim();
  if (p === "/dev/null") return undefined;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, "$1");
  return p.startsWith("b/") ? p.slice(2) : p;
}

/** Hinzugefuegte/geaenderte Zeilen je Datei aus `git diff -U0 <baseRef>`, gefiltert auf `include`-Globs. */
export async function changedLines(cwd: string, baseRef: string, include: string[]): Promise<Map<string, number[]>> {
  const out = await git(cwd, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U0", baseRef);
  const globs = include.map((g) => new Bun.Glob(g));
  const result = new Map<string, number[]>();
  let file: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const p = diffPath(line.slice(4));
      file = p !== undefined && globs.some((g) => g.match(p)) ? p : undefined;
      continue;
    }
    if (!file) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    const lines = result.get(file) ?? [];
    for (let i = 0; i < count; i++) lines.push(start + i);
    result.set(file, lines);
  }
  return result;
}

/**
 * Abdeckung der geaenderten Zeilen. Zeilen ohne `DA`-Eintrag sind nicht ausfuehrbar und zaehlen nicht;
 * Dateien ganz ohne `SF`-Eintrag zaehlen mit allen geaenderten Zeilen als nicht abgedeckt.
 */
export function coverageDiff(
  cov: Map<string, Map<number, number>>,
  changed: Map<string, number[]>,
): CoverageDiffResult {
  let covered = 0;
  let total = 0;
  const uncovered: { file: string; lines: number[] }[] = [];
  for (const [file, lines] of changed) {
    const fileCov = cov.get(file);
    const missing: number[] = [];
    for (const ln of lines) {
      if (!fileCov) {
        total++;
        missing.push(ln);
        continue;
      }
      const hits = fileCov.get(ln);
      if (hits === undefined) continue;
      total++;
      if (hits > 0) covered++;
      else missing.push(ln);
    }
    if (missing.length > 0) uncovered.push({ file, lines: missing });
  }
  return { covered, total, ratio: total === 0 ? 1 : covered / total, uncovered };
}
