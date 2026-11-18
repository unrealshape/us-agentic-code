import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regel-Compiler: macht aus der CLAUDE.md eines Projekts eine "Verfassung".
 * Jeder Listenpunkt ist eine Regel mit fester ID und Zeilenbeleg; Regeln aus
 * Regel-Abschnitten bilden den Kern (immer im Prompt), der Rest kommt als
 * Teil nur zu den Rollen, zu denen die Ueberschrift passt. Rein mechanisch, kein LLM.
 */
export type RuleKind = "must" | "must_not" | "info";

export type Rule = {
  id: string;
  text: string;
  section: string;
  kind: RuleKind;
  source: { path: string; lines: [number, number] };
};

export type RulePart = { name: string; roles: string[] | "all"; rules: Rule[] };

export type Constitution = { source_hash: string; core: Rule[]; parts: RulePart[] };

/** Hoechstzahl der Kernregeln; weitere Regeln aus Regel-Abschnitten wandern in Teile. */
export const CORE_LIMIT = 15;

const MUST_NOT = /\b(nie|niemals|kein|keine|nicht|never|do not|must not)\b/i;
const MUST = /\b(immer|muss|pflicht|always|must|required)\b/i;
const RULE_SECTION = /regel|rule|constraint|pflicht/i;

/** Rollen-Zuordnung eines Teils nach seiner Ueberschrift; erste passende Zeile gewinnt. */
const PART_ROLES: [RegExp, string[]][] = [
  [/test/i, ["test-engineer", "implementer", "qa-engineer"]],
  [/git|commit|push|merge/i, ["integrator", "implementer"]],
  [/review/i, ["code-reviewer", "security-reviewer"]],
  [/doku|docs|dokumentation/i, ["docs-writer"]],
];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function partRoles(heading: string): string[] | "all" {
  for (const [re, roles] of PART_ROLES) if (re.test(heading)) return [...roles];
  return "all";
}

/** Kopf einer Regel: fett gesetzter Anfang (`**...**`) oder sonst der erste Satz. */
function lead(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  if (bold) return bold[1]!;
  return text.split(/(?<=[.!?:])\s/)[0]!;
}

function classify(s: string): RuleKind | null {
  if (MUST_NOT.test(s)) return "must_not";
  if (MUST.test(s)) return "must";
  return null;
}

/**
 * Art einer Regel: Signalwort im Kopf entscheidet (Verbot vor Gebot), damit ein
 * Nebensatz wie "... nicht abschwaechen" ein Gebot nicht zum Verbot macht. Ohne
 * Signalwort ist ein Listenpunkt in einem Regel-Abschnitt ein Gebot; sonst zaehlt
 * der ganze Text, und ohne Treffer ist es eine Information.
 */
function kindOf(text: string, inRuleSection: boolean): RuleKind {
  const k = classify(lead(text));
  if (k) return k;
  if (inRuleSection) return "must";
  return classify(text) ?? "info";
}

const LIST_ITEM = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function compileRules(markdown: string, sourcePath: string): Constitution {
  const lines = markdown.split(/\r?\n/);
  const rules: Rule[] = [];
  let section = "";
  let fence: string | null = null;
  let open: { parts: string[]; start: number; end: number; indent: number; section: string } | null = null;

  const flush = () => {
    if (!open) return;
    const text = open.parts.join(" ").trim();
    if (text) {
      rules.push({
        id: `R-${sha256(text).slice(0, 8)}`,
        text,
        section: open.section,
        kind: kindOf(text, RULE_SECTION.test(open.section)),
        source: { path: sourcePath, lines: [open.start, open.end] },
      });
    }
    open = null;
  };

  lines.forEach((line, i) => {
    const no = i + 1;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1] === fence) fence = null;
      return;
    }
    if (f) {
      flush();
      fence = f[1]!;
      return;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      section = h[2]!;
      return;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      open = { parts: [item[2]!.trim()], start: no, end: no, indent: item[1]!.length, section };
      return;
    }
    // Eingerueckte Folgezeile gehoert zum offenen Listenpunkt; alles andere beendet ihn.
    if (open && line.trim() && /^\s+/.exec(line)![0].length > open.indent) {
      open.parts.push(line.trim());
      open.end = no;
      return;
    }
    flush();
  });
  flush();

  const core: Rule[] = [];
  const parts: RulePart[] = [];
  for (const rule of rules) {
    const isCore = rule.kind !== "info" && RULE_SECTION.test(rule.section);
    if (isCore && core.length < CORE_LIMIT) {
      core.push(rule);
      continue;
    }
    let part = parts.find((p) => p.name === rule.section);
    if (!part) {
      part = { name: rule.section, roles: partRoles(rule.section), rules: [] };
      parts.push(part);
    }
    part.rules.push(rule);
  }
  return { source_hash: sha256(markdown), core, parts };
}

/**
 * Laedt die Verfassung aus `<projectPath>/CLAUDE.md`. Der Cache liegt unter
 * `<cacheDir>/<sha>.json`; aendert sich die Datei, aendert sich der Hash und sie
 * wird neu kompiliert. Ohne CLAUDE.md: `null`.
 */
export function loadConstitution(projectPath: string, cacheDir: string): Constitution | null {
  const file = join(projectPath, "CLAUDE.md");
  if (!existsSync(file)) return null;
  const markdown = readFileSync(file, "utf8");
  const hash = sha256(markdown);
  const cached = join(cacheDir, `${hash}.json`);
  if (existsSync(cached)) {
    try {
      const c = JSON.parse(readFileSync(cached, "utf8")) as Constitution;
      if (c.source_hash === hash) return c;
    } catch {
      // kaputter Cache: neu kompilieren
    }
  }
  const c = compileRules(markdown, "CLAUDE.md");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, JSON.stringify(c, null, 2));
  return c;
}
