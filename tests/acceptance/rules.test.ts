import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence } from "../../packages/daemon/src/evidence";
import { rulesBlock } from "../../packages/daemon/src/prompts";
import { compileRules, CORE_LIMIT, loadConstitution, type Constitution, type Rule } from "../../packages/daemon/src/rules";
import { openStore } from "../../packages/daemon/src/store";

const REPO_CLAUDE_MD = join(import.meta.dir, "..", "..", "CLAUDE.md");

/** Projektordner mit einer Fixture-Kopie der CLAUDE.md dieses Repos (oder eigenem Inhalt). */
function project(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "usac-rules-"));
  if (content === undefined) copyFileSync(REPO_CLAUDE_MD, join(dir, "CLAUDE.md"));
  else writeFileSync(join(dir, "CLAUDE.md"), content);
  return dir;
}

const cache = () => mkdtempSync(join(tmpdir(), "usac-rules-cache-"));
const allRules = (c: Constitution): Rule[] => [...c.core, ...c.parts.flatMap((p) => p.rules)];

describe("Regel-Compiler (Phase 3)", () => {
  test("Regeln aus „Regeln für die Arbeit“ landen im Kern", () => {
    const c = loadConstitution(project(), cache())!;
    expect(c).not.toBeNull();
    // Der Regeltext bleibt wörtlich (Markdown-Hervorhebung inklusive), damit er belegbar ist.
    const rule = c.core.find((r) => /^\**R(ue|ü)ckw(ae|ä)rts entwickeln/.test(r.text));
    expect(rule).toBeDefined();
    expect(rule!.kind).toBe("must");
    expect(rule!.id).toMatch(/^R-[0-9a-f]{8}$/);
    expect(rule!.section).toMatch(/Regeln f(ue|ü)r die Arbeit/);
  });

  test("Verbote werden erkannt", () => {
    const c = loadConstitution(project(), cache())!;
    const rule = allRules(c).find((r) => r.text.includes("Keine Cloud-Dienste"));
    expect(rule).toBeDefined();
    expect(rule!.kind).toBe("must_not");
  });

  test("jede Regel ist prüfbar belegt", () => {
    const cwd = project();
    const c = loadConstitution(cwd, cache())!;
    const rules = allRules(c);
    expect(rules.length).toBeGreaterThan(0);
    const ctx = { cwd, store: openStore(join(cache(), "usac.db")), workItemId: "w1" };
    for (const rule of rules) {
      expect(rule.source.path).toBe("CLAUDE.md");
      const problem = checkEvidence(
        { type: "file", path: "CLAUDE.md", lines: rule.source.lines, quote: rule.text.slice(0, 30) },
        ctx,
      );
      expect(problem).toBeNull();
    }
  });

  test("Codeblöcke sind keine Regeln und CRLF ändert keine Zeilennummern", () => {
    const lf = [
      "# Projekt",
      "",
      "## Regeln",
      "",
      "- Tests muss man immer laufen lassen.",
      "",
      "```sh",
      "- nie pushen",
      "## Keine Überschrift",
      "```",
      "",
      "- Nie direkt auf main",
      "  committen.",
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    for (const md of [lf, crlf]) {
      const c = compileRules(md, "CLAUDE.md");
      const rules = allRules(c);
      expect(rules.some((r) => r.text.includes("nie pushen"))).toBe(false);
      expect(rules.every((r) => !r.text.includes("\r"))).toBe(true);
      expect(rules.map((r) => r.source.lines)).toEqual([
        [5, 5],
        [12, 13],
      ]);
      expect(rules.every((r) => r.section === "Regeln")).toBe(true);
      expect(rules[1]!.text).toBe("Nie direkt auf main committen.");
      expect(rules[1]!.kind).toBe("must_not");
    }
    expect(compileRules(lf, "CLAUDE.md").core.map((r) => r.id)).toEqual(compileRules(crlf, "CLAUDE.md").core.map((r) => r.id));
  });

  test("Kern ist begrenzt", () => {
    const items = Array.from({ length: 20 }, (_, i) => `- Regel ${i + 1} muss gelten.`);
    const c = compileRules(["## Regeln", ...items].join("\n"), "CLAUDE.md");
    expect(CORE_LIMIT).toBe(15);
    expect(c.core.length).toBe(15);
    const overflow = c.parts.flatMap((p) => p.rules);
    expect(overflow.length).toBe(5);
    expect(c.parts.filter((p) => p.rules.length > 0).length).toBe(1);
    expect(c.core.every((r) => r.kind === "must")).toBe(true);
  });

  test("Prompt der Rolle enthält nur passende Teile", () => {
    const md = [
      "# Projekt",
      "## Regeln",
      "- Niemals Secrets committen.",
      "## Tests",
      "- Jeder Test muss deterministisch sein.",
      "## Dokumentation",
      "- Doku immer auf Deutsch.",
    ].join("\n");
    const c = compileRules(md, "CLAUDE.md");
    const tests = c.parts.find((p) => p.name === "Tests")!;
    expect(tests.roles).toEqual(["test-engineer", "implementer", "qa-engineer"]);
    expect(c.parts.find((p) => p.name === "Dokumentation")!.roles).toEqual(["docs-writer"]);
    const testRule = tests.rules[0]!;
    const core = c.core[0]!;

    const impl = rulesBlock(c, "implementer");
    expect(impl).toContain("Verfassung des Projekts");
    expect(impl).toContain(`[${core.id}]`);
    expect(impl).toContain(`[${testRule.id}] ${testRule.text}`);
    expect(impl).not.toContain("Doku immer auf Deutsch.");

    const docs = rulesBlock(c, "docs-writer");
    expect(docs).toContain(`[${core.id}]`);
    expect(docs).not.toContain(testRule.id);
    expect(docs).toContain("Doku immer auf Deutsch.");
  });

  test("geänderte CLAUDE.md erneuert die Verfassung", () => {
    const dir = project("## Regeln\n- Immer testen.\n");
    const cacheDir = cache();
    const first = loadConstitution(dir, cacheDir)!;
    expect(existsSync(join(cacheDir, `${first.source_hash}.json`))).toBe(true);
    expect(loadConstitution(dir, cacheDir)).toEqual(first);
    writeFileSync(join(dir, "CLAUDE.md"), "## Regeln\n- Immer testen.\n- Nie pushen.\n");
    const second = loadConstitution(dir, cacheDir)!;
    expect(second.source_hash).not.toBe(first.source_hash);
    expect(allRules(second).some((r) => r.text === "Nie pushen.")).toBe(true);
  });

  test("ohne CLAUDE.md gibt es keine Verfassung", () => {
    expect(loadConstitution(mkdtempSync(join(tmpdir(), "usac-rules-empty-")), cache())).toBeNull();
  });
});
