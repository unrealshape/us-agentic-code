import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readHookLog } from "../src/hook-log";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = join(REPO_ROOT, "hooks/scripts/gateguard.ts");
const PREFIX = "GateGuard: Bevor du";

type Ctx = { cwd: string; state: string; log: string };

function ctx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "usac-gateguard-"));
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/a.lua"), "return {}\n");
  return { cwd, state: join(dir, "state.json"), log: join(dir, "hooks.jsonl") };
}

async function runGate(
  input: unknown,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stderr: string }> {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT };
  for (const k of ["USAC_GATEGUARD", "USAC_GATEGUARD_STATE", "USAC_GATEGUARD_EXEMPT", "USAC_HOOK_LOG"]) delete base[k];
  const proc = Bun.spawn(["bun", SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const code = await proc.exited;
  return { code, stderr: await new Response(proc.stderr).text() };
}

function edit(c: Ctx, file: string, session = "s1") {
  return { session_id: session, tool_name: "Edit", tool_input: { file_path: file, old_string: "a", new_string: "b" }, cwd: c.cwd };
}

function on(c: Ctx, extra: Record<string, string> = {}) {
  return { USAC_GATEGUARD: "1", USAC_GATEGUARD_STATE: c.state, USAC_HOOK_LOG: c.log, ...extra };
}

describe("GateGuard", () => {
  test("erste Änderung je Datei wird verweigert", async () => {
    const c = ctx();
    const res = await runGate(edit(c, "src/a.lua"), on(c));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`${PREFIX} src/a.lua änderst, nenne diese Fakten:`);
    expect(res.stderr).toContain("importieren");
    expect(res.stderr).toContain("öffentlichen Funktionen");
    expect(res.stderr).toContain("Datenformate");
    expect(res.stderr).toContain("wörtlich");
    const entries = readHookLog(c.log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hook).toBe("gateguard");
    expect(entries[0]!.action).toBe("denied");
    expect(entries[0]!.tool).toBe("Edit");
    expect(entries[0]!.target).toBe("src/a.lua");
  });

  test("zweiter Versuch ist erlaubt", async () => {
    const c = ctx();
    expect((await runGate(edit(c, "src/a.lua"), on(c))).code).toBe(2);
    const second = await runGate(edit(c, "src/a.lua"), on(c));
    expect(second.code).toBe(0);
    const entries = readHookLog(c.log);
    expect(entries.map((e) => e.action)).toEqual(["denied", "allowed"]);
  });

  test("neue Datei bekommt die Write-Fragen", async () => {
    const c = ctx();
    const res = await runGate(
      { session_id: "s1", tool_name: "Write", tool_input: { file_path: "src/neu.lua", content: "x" }, cwd: c.cwd },
      on(c),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`${PREFIX} src/neu.lua änderst, nenne diese Fakten:`);
    expect(res.stderr).toContain("aufrufen");
    expect(res.stderr).toContain("ähnliche vorhandene Datei");
    expect(res.stderr).not.toContain("öffentlichen Funktionen");
  });

  test("Schreibweisen sind eine Datei", async () => {
    const c = ctx();
    const absBackslash = `${c.cwd.replace(/\//g, "\\")}\\src\\a.lua`;
    expect((await runGate(edit(c, absBackslash), on(c))).code).toBe(2);
    expect((await runGate(edit(c, "src/a.lua"), on(c))).code).toBe(0);
  });

  test("andere Session fragt erneut", async () => {
    const c = ctx();
    // eigener Zustand je Session ueber den Standardpfad (ohne USAC_GATEGUARD_STATE)
    const s1 = `t-${Date.now()}-a`;
    const s2 = `t-${Date.now()}-b`;
    const env = { USAC_GATEGUARD: "1" };
    expect((await runGate(edit(c, "src/a.lua", s1), env)).code).toBe(2);
    expect((await runGate(edit(c, "src/a.lua", s1), env)).code).toBe(0);
    expect((await runGate(edit(c, "src/a.lua", s2), env)).code).toBe(2);
    expect(existsSync(join(tmpdir(), `usac-gateguard-${s1}.json`))).toBe(true);
    expect(existsSync(join(tmpdir(), `usac-gateguard-${s2}.json`))).toBe(true);
  });

  test("ohne USAC_GATEGUARD inaktiv", async () => {
    const c = ctx();
    const res = await runGate(edit(c, "src/a.lua"), { USAC_GATEGUARD_STATE: c.state, USAC_HOOK_LOG: c.log });
    expect(res.code).toBe(0);
    expect(existsSync(c.state)).toBe(false);
    expect(existsSync(c.log)).toBe(false);
  });

  test("Bash nie betroffen", async () => {
    const c = ctx();
    const res = await runGate({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo x > src/a.lua" }, cwd: c.cwd }, on(c));
    expect(res.code).toBe(0);
    expect(existsSync(c.state)).toBe(false);
  });

  test("MultiEdit und NotebookEdit werden geprüft", async () => {
    const c = ctx();
    const me = await runGate({ session_id: "s1", tool_name: "MultiEdit", tool_input: { file_path: "src/a.lua", edits: [] }, cwd: c.cwd }, on(c));
    expect(me.code).toBe(2);
    writeFileSync(join(c.cwd, "nb.ipynb"), "{}");
    const nb = await runGate({ session_id: "s1", tool_name: "NotebookEdit", tool_input: { notebook_path: "nb.ipynb", new_source: "x" }, cwd: c.cwd }, on(c));
    expect(nb.code).toBe(2);
    expect(nb.stderr).toContain(`${PREFIX} nb.ipynb änderst`);
  });

  test("Ausnahme-Glob wirkt", async () => {
    const c = ctx();
    const env = on(c, { USAC_GATEGUARD_EXEMPT: "docs/**, src/*.lua" });
    expect((await runGate(edit(c, "src/a.lua"), env)).code).toBe(0);
    expect((await runGate(edit(c, "lib/b.lua"), env)).code).toBe(2);
  });

  test("kaputter Zustand: fail-open nur bei eigenen Fehlern, nie blockierend", async () => {
    const c = ctx();
    writeFileSync(c.state, "{kaputt");
    const res = await runGate(edit(c, "src/a.lua"), on(c));
    // kaputter Zustand gilt als leer: erste Änderung wird normal verweigert
    expect(res.code).toBe(2);
    expect(JSON.parse(readFileSync(c.state, "utf8"))).toHaveProperty(["src/a.lua"]);
    const garbage = await runGate("kein json", on(c));
    expect(garbage.code).toBe(0);
  });

  test("hooks.json enthält den GateGuard-Eintrag nach dem Protector-Eintrag", () => {
    const hooks = JSON.parse(readFileSync(join(REPO_ROOT, "hooks/hooks.json"), "utf8"));
    const pre = hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>;
    const pi = pre.findIndex((e) => e.hooks.some((h) => h.command.includes("protector.ts")));
    const gi = pre.findIndex((e) => e.hooks.some((h) => h.command.includes("gateguard.ts")));
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(gi).toBeGreaterThan(pi);
    expect(pre[gi]!.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(pre[gi]!.hooks[0]!.command).toBe('bun "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gateguard.ts"');
    expect(pre[gi]!.hooks[0]!.timeout).toBe(10);
  });
});
