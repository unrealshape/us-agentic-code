import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { z } from "zod";
import type { Finding } from "@usac/shared";

/**
 * ADR-Pflicht fuer neue Abhaengigkeiten (Regel 6 im Ziel-Projekt, ADR 0006).
 * Vergleicht die Manifeste der Basis mit dem Arbeitsstand. Parser bewusst zeilenbasiert
 * (bzw. JSON.parse fuer package.json); TOML nur ueber die genannten Abschnitte, kein TOML-Parser.
 */
export type NewDependency = { manifest: string; name: string };

type DepLine = { name: string; line: number; quote: string };
type Parser = (text: string) => DepLine[];

const splitLines = (text: string) => text.split(/\r?\n/);

/** Erste Zeile ab `from`, die `pred` erfuellt (1-basiert), sonst die Zeile `fallback`. */
function locate(lines: string[], pred: (l: string) => boolean, fallback = 1): number {
  const i = lines.findIndex(pred);
  return i >= 0 ? i + 1 : fallback;
}

const dep = (lines: string[], name: string, line: number): DepLine => ({ name, line, quote: lines[line - 1]!.trim() || name });

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const packageJson: Parser = (text) => {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const lines = splitLines(text);
  const out: DepLine[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    const block = data[key];
    if (!block || typeof block !== "object") continue;
    // Zeile innerhalb des Blocks suchen, damit gleichnamige Eintraege in anderen Bloecken nicht zaehlen.
    const start = Math.max(0, lines.findIndex((l) => l.includes(`"${key}"`)));
    for (const name of Object.keys(block)) {
      const re = new RegExp(`"${escapeRe(name)}"\\s*:`);
      const rel = lines.slice(start).findIndex((l) => re.test(l));
      const line = rel >= 0 ? start + rel + 1 : locate(lines, (l) => re.test(l));
      out.push(dep(lines, name, line));
    }
  }
  return out;
};

const goMod: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  let inBlock = false;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\/\/.*$/, "").trim();
    if (inBlock) {
      if (l === ")") inBlock = false;
      else {
        const m = /^(\S+)\s+\S+/.exec(l);
        if (m) out.push(dep(lines, m[1]!, i + 1));
      }
      return;
    }
    if (/^require\s*\($/.test(l)) inBlock = true;
    else {
      const m = /^require\s+(\S+)\s+\S+/.exec(l);
      if (m) out.push(dep(lines, m[1]!, i + 1));
    }
  });
  return out;
};

/** Abschnittsname einer TOML-Kopfzeile `[a.b]`, sonst null. */
const tomlSection = (l: string): string | null => {
  const m = /^\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/.exec(l);
  return m ? m[1]! : null;
};

const cargoToml: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  const DEP_SECTIONS = ["dependencies", "dev-dependencies"];
  let section: string | null = null;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const s = tomlSection(l);
    if (s !== null) {
      section = s;
      // Tabellen-Form `[dependencies.serde]`.
      for (const d of DEP_SECTIONS) if (s.startsWith(`${d}.`)) out.push(dep(lines, s.slice(d.length + 1).replace(/"/g, ""), i + 1));
      return;
    }
    if (!section || !DEP_SECTIONS.includes(section)) return;
    const m = /^"?([A-Za-z0-9_.-]+)"?\s*=/.exec(l);
    if (m) out.push(dep(lines, m[1]!, i + 1));
  });
  return out;
};

/** PEP 503: Namen vergleichbar machen (Gross/Klein, `-`, `_`, `.`). */
const pyName = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
const PY_REQ = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;

const pyprojectToml: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  let section: string | null = null;
  let inList = false;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const s = tomlSection(l);
    if (s !== null) {
      section = s;
      inList = false;
      return;
    }
    if (section !== "project") return;
    let rest: string | null = null;
    if (inList) rest = l;
    else {
      const m = /^dependencies\s*=\s*\[(.*)$/.exec(l);
      if (m) {
        inList = true;
        rest = m[1]!;
      }
    }
    if (rest === null) return;
    const close = rest.indexOf("]");
    const body = close >= 0 ? rest.slice(0, close) : rest;
    if (close >= 0) inList = false;
    for (const q of body.matchAll(/["']([^"']+)["']/g)) {
      const m = PY_REQ.exec(q[1]!);
      if (m) out.push(dep(lines, pyName(m[1]!), i + 1));
    }
  });
  return out;
};

const requirementsTxt: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  lines.forEach((raw, i) => {
    const l = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!l || l.startsWith("-")) return;
    const m = PY_REQ.exec(l);
    if (m) out.push(dep(lines, pyName(m[1]!), i + 1));
  });
  return out;
};

const csproj: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  lines.forEach((raw, i) => {
    for (const m of raw.matchAll(/<PackageReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"/g)) out.push(dep(lines, m[1]!, i + 1));
  });
  return out;
};

const pomXml: Parser = (text) => {
  const lines = splitLines(text);
  const out: DepLine[] = [];
  let inDep = false;
  lines.forEach((raw, i) => {
    if (/<dependency>/.test(raw)) inDep = true;
    if (inDep) {
      const m = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(raw);
      if (m) out.push(dep(lines, m[1]!, i + 1));
    }
    if (/<\/dependency>/.test(raw)) inDep = false;
  });
  return out;
};

/** Parser je Manifest-Dateiname (ohne Ordner). */
function parserFor(path: string): Parser | null {
  const base = posix.basename(path.replace(/\\/g, "/"));
  if (base === "package.json") return packageJson;
  if (base === "go.mod") return goMod;
  if (base === "Cargo.toml") return cargoToml;
  if (base === "pyproject.toml") return pyprojectToml;
  if (/^requirements.*\.txt$/.test(base)) return requirementsTxt;
  if (/\.csproj$/.test(base)) return csproj;
  if (base === "pom.xml") return pomXml;
  return null;
}

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }
}

const gitLines = (out: string | null) => (out ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Versionierte und neue (nicht ignorierte) Dateien des Arbeitsstands. */
const workingFiles = (cwd: string) => gitLines(gitOut(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]));

/** Neue Abhaengigkeiten mit Fundstelle im Arbeitsstand (Zeile, Zitat). */
function newDependencyLines(cwd: string, baseRef: string): (DepLine & { manifest: string })[] {
  const out: (DepLine & { manifest: string })[] = [];
  for (const manifest of workingFiles(cwd)) {
    const parse = parserFor(manifest);
    if (!parse) continue;
    const full = join(cwd, manifest);
    if (!existsSync(full)) continue;
    const before = new Set(parse(gitOut(cwd, ["show", `${baseRef}:${manifest}`]) ?? "").map((d) => d.name));
    const seen = new Set<string>();
    for (const d of parse(readFileSync(full, "utf8"))) {
      if (before.has(d.name) || seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ manifest, ...d });
    }
  }
  return out;
}

/** Neue Abhaengigkeiten gegenueber `baseRef`; reine Versionsaenderungen zaehlen nicht. */
export function newDependencies(cwd: string, baseRef: string): NewDependency[] {
  return newDependencyLines(cwd, baseRef).map(({ manifest, name }) => ({ manifest, name }));
}

/** Gibt es unter `adrDir` eine neue oder geaenderte Datei gegenueber `baseRef`? */
function adrTouched(cwd: string, baseRef: string, adrDir: string): boolean {
  const dir = adrDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (gitLines(gitOut(cwd, ["diff", "--name-only", baseRef, "--", dir])).length) return true;
  return gitLines(gitOut(cwd, ["ls-files", "--others", "--exclude-standard", "--", dir])).length > 0;
}

/** Regel 6: jede neue Abhaengigkeit ohne neues oder geaendertes ADR ist ein `high`-Befund mit Zeilen-Beleg. */
export function checkAdrRule(cwd: string, baseRef: string, adrDir: string): z.infer<typeof Finding>[] {
  const deps = newDependencyLines(cwd, baseRef);
  if (!deps.length || adrTouched(cwd, baseRef, adrDir)) return [];
  return deps.map((d) => ({
    severity: "high" as const,
    text: `Neue Abhängigkeit ${d.name} ohne ADR (Regel 6)`,
    evidence: [{ type: "file" as const, path: d.manifest, lines: [d.line, d.line] as [number, number], quote: d.quote }],
  }));
}
