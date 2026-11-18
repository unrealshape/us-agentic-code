import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImplementerOutput, ReviewerOutput, TestEngineerOutput } from "@usac/shared";
import { REPO_ROOT, setupProject } from "../../../tests/helpers";
import { checkEvidence, findHedges, validateClaims, validateFindings } from "../src/evidence";
import { checkImplementerDiff, hashFiles } from "../src/integrity";
import { loadGateProfile } from "../src/config";
import { loadRouting, resolveModel } from "../src/routing";
import { buildArgs, buildSettings, ClaudeRunner, parseJsonLoose } from "../src/runner/claude";
import { openStore } from "../src/store";

const store = openStore(":memory:");

describe("Routing", () => {
  const cfg = loadRouting(REPO_ROOT);
  test("Standardmodelle je Rolle", () => {
    expect(resolveModel(cfg, "implementer").model).toBe("sonnet");
    expect(resolveModel(cfg, "explorer").model).toBe("haiku");
    expect(resolveModel(cfg, "test-engineer", { variant: "acceptance" }).model).toBe("sonnet");
    expect(resolveModel(cfg, "test-engineer", { variant: "slices" }).model).toBe("sonnet");
    expect(resolveModel(cfg, "security-reviewer").model).toBe("opus");
  });
  test("Fable nur fuer den Architekten, alle anderen Rollen max. Opus", () => {
    expect(resolveModel(cfg, "architect", { size: "large" }).model).toBe("fable");
    expect(resolveModel(cfg, "code-reviewer", { size: "large" }).model).toBe("opus");
    expect(resolveModel(cfg, "implementer", { size: "large" }).model).toBe("sonnet");
    expect(resolveModel(cfg, "security-reviewer", { failures: 9 }).model).toBe("opus");
  });
  test("Fehlversuche heben stufenweise, gedeckelt bei Opus ausser beim Architekten", () => {
    expect([0, 1, 2, 3, 4, 9].map((f) => resolveModel(cfg, "implementer", { failures: f }).model)).toEqual([
      "sonnet", "sonnet", "opus", "opus", "opus", "opus",
    ]);
    expect(resolveModel(cfg, "architect", { failures: 4 }).model).toBe("fable");
  });
  test("Kontingent bremst, Security ist ausgenommen, Fable braucht Freigabe", () => {
    expect(resolveModel(cfg, "code-reviewer", { budgetUsed: 0.95 }).model).toBe("sonnet");
    expect(resolveModel(cfg, "security-reviewer", { budgetUsed: 0.95 }).model).toBe("opus");
    const r = resolveModel(cfg, "architect", { failures: 4, budgetUsed: 0.8 });
    expect(r.model).toBe("fable");
    expect(r.needsApproval).toBe(true);
  });
  test("fehlendes Modell faellt auf die naechste Stufe zurueck", () => {
    const r = resolveModel(cfg, "security-reviewer", { available: ["haiku", "sonnet", "opus"] });
    expect(r.model).toBe("opus");
  });
  test("unbekannte Rolle ist ein Fehler", () => {
    expect(() => resolveModel(cfg, "magier")).toThrow();
  });
});

describe("Belegpruefung", () => {
  const cwd = setupProject();
  const ctx = { cwd, store, workItemId: "wi_x", urlAllowlist: ["lua.org"] };
  test("korrektes Zitat wird akzeptiert, Leerraum egal", () => {
    expect(checkEvidence({ type: "file", path: "src/rotation.lua", lines: [8, 9], quote: "for _, spell in ipairs(spells) do   if best == nil" }, ctx)).toBeNull();
  });
  test("falsches Zitat, falsche Zeilen, fremde Pfade werden abgelehnt", () => {
    expect(checkEvidence({ type: "file", path: "src/rotation.lua", lines: [1, 1], quote: "next_spell" }, ctx)).toContain("Zitat");
    expect(checkEvidence({ type: "file", path: "src/rotation.lua", lines: [90, 91], quote: "x" }, ctx)).toContain("Zeilen");
    expect(checkEvidence({ type: "file", path: "../etc/passwd", lines: [1, 1], quote: "x" }, ctx)).toContain("ausserhalb");
    expect(checkEvidence({ type: "file", path: "/etc/passwd", lines: [1, 1], quote: "x" }, ctx)).toContain("ausserhalb");
    expect(checkEvidence({ type: "file", path: "src/gibtsnicht.lua", lines: [1, 1], quote: "x" }, ctx)).toContain("existiert nicht");
  });
  test("URLs nur von der Allowlist", () => {
    expect(checkEvidence({ type: "url", url: "https://www.lua.org/manual/5.4/" }, ctx)).toBeNull();
    expect(checkEvidence({ type: "url", url: "https://random-blog.example/lua" }, ctx)).toContain("Allowlist");
  });
  test("EXTRACTED ohne Beleg ist ungueltig, UNKNOWN ohne Beleg erlaubt", () => {
    expect(validateClaims([{ text: "a", level: "EXTRACTED", evidence: [] }], ctx)).toHaveLength(1);
    expect(validateClaims([{ text: "a", level: "UNKNOWN", evidence: [] }], ctx)).toHaveLength(0);
  });
  test("critical/high-Befunde brauchen Belege", () => {
    expect(validateFindings([{ severity: "high", text: "x", evidence: [] }], ctx)).toHaveLength(1);
    expect(validateFindings([{ severity: "low", text: "x", evidence: [] }], ctx)).toHaveLength(0);
  });
  test("Vermutungswoerter werden erkannt", () => {
    expect(findHedges("Das sollte jetzt gehen")).toEqual(["sollte jetzt"]);
    expect(findHedges("This should work, probably.")).toEqual(["should work", "probably"]);
    expect(findHedges("busted: 3 successes / 0 failures")).toEqual([]);
  });
});

describe("Integritaet", () => {
  test("Hash aendert sich bei jeder Aenderung des Tests", () => {
    const cwd = setupProject();
    const h1 = hashFiles(cwd, ["spec/rotation_spec.lua"]);
    writeFileSync(join(cwd, "spec/rotation_spec.lua"), readFileSync(join(cwd, "spec/rotation_spec.lua"), "utf8") + " ");
    expect(hashFiles(cwd, ["spec/rotation_spec.lua"])).not.toBe(h1);
  });
  test("Anti-Schummel erkennt Testdateien, Gate-Konfiguration und Skip-Marker", async () => {
    const cwd = setupProject();
    const gp = loadGateProfile(REPO_ROOT, "lua");
    writeFileSync(join(cwd, "spec/new_spec.lua"), "x");
    writeFileSync(join(cwd, ".luacheckrc"), "std = 'max'\nignore = {'.*'}\n");
    writeFileSync(join(cwd, "src/helper.lua"), "-- luacheck: ignore\nreturn {}\n");
    writeFileSync(join(cwd, "src/ok.lua"), "return 1\n");
    const v = await checkImplementerDiff(cwd, "HEAD", gp, ["spec/rotation_spec.lua"]);
    expect(v.map((x) => `${x.path}:${x.reason}`).sort()).toEqual([
      ".luacheckrc:protected_file",
      "spec/new_spec.lua:test_file",
      "src/helper.lua:skip_marker",
    ]);
  });
});

describe("Schemas", () => {
  test("JSON-Schemas fuer --json-schema existieren und passen zu zod", () => {
    for (const role of ["test-engineer", "implementer", "code-reviewer", "security-reviewer"]) {
      const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", `${role}.schema.json`), "utf8"));
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("claims");
    }
    expect(TestEngineerOutput.safeParse({ summary: "", acceptance_tests: [], claims: [] }).success).toBe(false);
    expect(ImplementerOutput.safeParse({ summary: "x", changed_files: [], claims: [] }).success).toBe(true);
    expect(ReviewerOutput.safeParse({ verdict: "maybe", summary: "", findings: [], claims: [] }).success).toBe(false);
  });
});

describe("ClaudeRunner", () => {
  const spec = { role: "implementer", model: "sonnet" as const, prompt: "fix", cwd: "/tmp/wt", schema: { type: "object" }, systemPrompt: "Rolle", maxTurns: 3 };

  test("baut die CLI-Argumente fuer den Headless-Betrieb", () => {
    const args = buildArgs(spec, "/tmp/s.json", { pluginDir: "/plug" });
    expect(args.slice(0, 2)).toEqual(["-p", "fix"]);
    for (const a of ["--output-format", "stream-json", "--model", "sonnet", "--json-schema", "--append-system-prompt", "--plugin-dir", "--settings"]) {
      expect(args).toContain(a);
    }
    const s = buildSettings(spec, true) as any;
    expect(s.sandbox.enabled).toBe(true);
    expect(s.permissions.allow).toContain("Edit(//tmp/wt/**)");
  });

  test("Windows-Pfade bleiben in den Permission-Regeln erhalten (Laufwerk, Slashes)", () => {
    const winSpec = { ...spec, cwd: "C:\\Users\\jok\\proj" };
    const s = buildSettings(winSpec, false) as any;
    expect(s.permissions.allow).toContain("Edit(//C:/Users/jok/proj/**)");
    expect(s.permissions.allow).toContain("Write(//C:/Users/jok/proj/**)");
  });

  test("liest Stream, strukturierte Ausgabe und Tokens", async () => {
    const bin = fakeClaude([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Ich pruefe." }] } },
      { type: "result", subtype: "success", is_error: false, result: "fertig", structured_output: { summary: "ok", changed_files: [], claims: [] }, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const events: string[] = [];
    const r = await new ClaudeRunner({ bin, sandbox: false }).run({ ...spec, cwd: tmpdir() }, (e) => events.push(e.text));
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ summary: "ok", changed_files: [], claims: [] });
    expect(r.sessionId).toBe("s1");
    expect(r.tokens).toEqual({ input: 10, output: 5 });
    expect(events).toContain("Ich pruefe.");
  });

  test("bricht bei Ueberschreitung des Turn-Limits ab", async () => {
    const turn = { type: "assistant", message: { content: [{ type: "text", text: "..." }] } };
    const bin = fakeClaude([turn, turn, turn, turn, turn], 0.05);
    const r = await new ClaudeRunner({ bin, sandbox: false }).run({ ...spec, cwd: tmpdir(), maxTurns: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Turn-Limit");
  });

  test("JSON aus Text wird notfalls geparst", () => {
    expect(parseJsonLoose('Ergebnis:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose("kein json")).toBeUndefined();
  });
});

/** Baut ein Fake-claude-Binary, das die gegebenen Stream-Zeilen ausgibt. */
function fakeClaude(lines: object[], delaySec = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  const body = lines.map((l) => `echo '${JSON.stringify(l).replaceAll("'", "'\\''")}'${delaySec ? `; sleep ${delaySec}` : ""}`).join("\n");
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("Git-Zeilenenden (Windows)", () => {
  test("revertPaths stellt die Bytes des Abnahmetests exakt wieder her, auch mit core.autocrlf=true", async () => {
    const { revertPaths } = await import("../src/integrity");
    const { git } = await import("../src/exec");
    const dir = mkdtempSync(join(tmpdir(), "crlf-"));
    await git(dir, "init", "-q");
    await git(dir, "config", "core.autocrlf", "true");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.lua"), "a\nb\nc\n");
    await git(dir, "add", "f.lua");
    await git(dir, "commit", "-qm", "init");
    const locked = hashFiles(dir, ["f.lua"]);
    writeFileSync(join(dir, "f.lua"), "x\n");
    await revertPaths(dir, "HEAD", ["f.lua"]);
    expect(hashFiles(dir, ["f.lua"])).toBe(locked);
  });
});
