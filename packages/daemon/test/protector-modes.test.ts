import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendHookLog, parseProtectorMode, readHookLog } from "../src/hook-log";
import { ProjectProfile, GateProfile } from "../src/config";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const FORCE_PUSH = "git push --force origin x";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "usac-protector-"));
}

async function runProtector(
  input: unknown,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stderr: string }> {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT };
  delete base.USAC_PROTECTOR_MODE;
  delete base.USAC_HOOK_LOG;
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "hooks/scripts/protector.ts")], {
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

function bash(command: string, cwd: string) {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

describe("Protector-Modi", () => {
  test("blockieren: Exit 2 und Log-Zeile blocked", async () => {
    const cwd = tmp();
    const log = join(cwd, "hooks.jsonl");
    const res = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "blockieren", USAC_HOOK_LOG: log });
    expect(res.code).toBe(2);
    const entries = readHookLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hook).toBe("protector");
    expect(entries[0]!.mode).toBe("blockieren");
    expect(entries[0]!.action).toBe("blocked");
    expect(entries[0]!.rule).toContain("git push --force");
    expect(entries[0]!.tool).toBe("Bash");
    expect(entries[0]!.target).toBe(FORCE_PUSH);
  });

  test("melden: Exit 0 und Log-Zeile reported", async () => {
    const cwd = tmp();
    const log = join(cwd, "hooks.jsonl");
    const res = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "melden", USAC_HOOK_LOG: log });
    expect(res.code).toBe(0);
    const entries = readHookLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("reported");
    expect(entries[0]!.mode).toBe("melden");
  });

  test("lernen: Exit 0 und Log-Zeile learned", async () => {
    const cwd = tmp();
    const log = join(cwd, "hooks.jsonl");
    const res = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "lernen", USAC_HOOK_LOG: log });
    expect(res.code).toBe(0);
    const entries = readHookLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("learned");
  });

  test("Tippfehler gilt als blockieren", async () => {
    const cwd = tmp();
    const log = join(cwd, "hooks.jsonl");
    const viaEnv = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "blockiern", USAC_HOOK_LOG: log });
    expect(viaEnv.code).toBe(2);
    expect(readHookLog(log)[0]!.action).toBe("blocked");

    const proj = tmp();
    mkdirSync(join(proj, ".usac"), { recursive: true });
    writeFileSync(
      join(proj, ".usac/project.yaml"),
      "name: demo\ngate_profile: lua\nprotector:\n  mode: blockiern\n",
    );
    const viaProfile = await runProtector(bash(FORCE_PUSH, proj), {});
    expect(viaProfile.code).toBe(2);
  });

  test("Modus aus .usac/project.yaml wird ohne Variable gelesen", async () => {
    const proj = tmp();
    mkdirSync(join(proj, ".usac"), { recursive: true });
    writeFileSync(join(proj, ".usac/project.yaml"), "name: demo\ngate_profile: lua\nprotector:\n  mode: melden\n");
    const res = await runProtector(bash(FORCE_PUSH, proj), {});
    expect(res.code).toBe(0);
  });

  test("ohne USAC_HOOK_LOG kein Log, Verhalten gleich", async () => {
    const cwd = tmp();
    const res = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "blockieren" });
    expect(res.code).toBe(2);
    expect(existsSync(join(cwd, "hooks.jsonl"))).toBe(false);
    const melden = await runProtector(bash(FORCE_PUSH, cwd), { USAC_PROTECTOR_MODE: "melden" });
    expect(melden.code).toBe(0);
  });

  test("harmloser Befehl: ls -> Exit 0, keine Log-Zeile", async () => {
    const cwd = tmp();
    const log = join(cwd, "hooks.jsonl");
    const res = await runProtector(bash("ls", cwd), { USAC_PROTECTOR_MODE: "blockieren", USAC_HOOK_LOG: log });
    expect(res.code).toBe(0);
    expect(readHookLog(log)).toEqual([]);
  });
});

describe("hook-log", () => {
  test("readHookLog ueberspringt eine abgeschnittene letzte Zeile", () => {
    const dir = tmp();
    const log = join(dir, "sub/hooks.jsonl");
    appendHookLog(log, { ts: "2026-11-18T00:00:00Z", hook: "protector", mode: "melden", action: "reported", rule: "r", tool: "Bash", target: "x" });
    appendHookLog(log, { ts: "2026-11-18T00:00:01Z", hook: "gateguard", action: "denied", tool: "Edit", target: "a.ts" });
    writeFileSync(log, `${require("node:fs").readFileSync(log, "utf8")}{"ts":"2026-11-18T00:00:02Z","hook":"prot`);
    const entries = readHookLog(log);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.hook).toBe("gateguard");
  });

  test("readHookLog auf fehlender Datei liefert leere Liste", () => {
    expect(readHookLog(join(tmp(), "fehlt.jsonl"))).toEqual([]);
  });

  test("parseProtectorMode: unbekannt oder leer -> blockieren", () => {
    expect(parseProtectorMode("lernen")).toBe("lernen");
    expect(parseProtectorMode("melden")).toBe("melden");
    expect(parseProtectorMode("blockieren")).toBe("blockieren");
    expect(parseProtectorMode("blockiern")).toBe("blockieren");
    expect(parseProtectorMode("")).toBe("blockieren");
    expect(parseProtectorMode(undefined)).toBe("blockieren");
    expect(parseProtectorMode(42)).toBe("blockieren");
  });
});

describe("Profil-Felder", () => {
  test("ProjectProfile: Standardwerte fuer protector, gateguard, network", () => {
    const p = ProjectProfile.parse({ name: "x", gate_profile: "lua" });
    expect(p.protector).toEqual({ mode: "blockieren" });
    expect(p.gateguard).toEqual({ enabled: true });
    expect(p.network).toEqual({ allow: [] });
  });

  test("ProjectProfile: Tippfehler im Modus wird blockieren statt Parse-Fehler", () => {
    const p = ProjectProfile.parse({ name: "x", gate_profile: "lua", protector: { mode: "blockiern" } });
    expect(p.protector.mode).toBe("blockieren");
    const q = ProjectProfile.parse({ name: "x", gate_profile: "lua", protector: { mode: "lernen" }, network: { allow: ["github.com"] } });
    expect(q.protector.mode).toBe("lernen");
    expect(q.network.allow).toEqual(["github.com"]);
  });

  test("GateProfile: network_allow Standard leer", () => {
    const g = GateProfile.parse({ name: "x", acceptance: { run: "true" }, stages: [] });
    expect(g.network_allow).toEqual([]);
  });
});
