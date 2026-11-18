import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { NETWORK_KEY_PATH, buildEnv, buildSettings, validateHosts } from "../src/runner/claude";
import type { RunSpec } from "../src/runner/types";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const spec: RunSpec = { role: "developer", model: "haiku", prompt: "p", cwd: "/tmp/wt" };

/** Liest den Wert unter einem Schluesselpfad; undefined, wenn ein Glied fehlt. */
function at(obj: unknown, path: string[]): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

describe("Sandbox-Netzwerk-Allowlist", () => {
  test("NETWORK_KEY_PATH ist der belegte Schluessel aus ADR 0005", () => {
    expect(NETWORK_KEY_PATH).toEqual(["sandbox", "network", "allowedDomains"]);
  });

  test("Allowlist landet unter dem belegten Schlüssel", () => {
    const s = buildSettings({ ...spec, networkAllow: ["registry.npmjs.org"] }, true);
    expect(at(s, NETWORK_KEY_PATH)).toEqual(["registry.npmjs.org"]);
  });

  test("ohne Allowlist kein Netz", () => {
    const leer = buildSettings({ ...spec, networkAllow: [] }, true);
    expect(at(leer, NETWORK_KEY_PATH)).toEqual([]);
    const fehlend = buildSettings(spec, true);
    expect(at(fehlend, NETWORK_KEY_PATH)).toEqual([]);
  });

  test("Hosts ausserhalb der Allowlist werden abgelehnt statt erfragt", () => {
    const s = buildSettings(spec, true);
    expect(at(s, ["sandbox", "network", "strictAllowlist"])).toBe(true);
  });

  test("ungültige Hosts brechen ab", () => {
    for (const bad of [["*"], ["http://x.de"], [""]]) {
      expect(() => validateHosts(bad)).toThrow("Ungültiger Host");
      expect(() => buildSettings({ ...spec, networkAllow: bad }, true)).toThrow("Ungültiger Host");
    }
    expect(() => validateHosts(["*"])).toThrow("Ungültiger Host in network.allow: *");
  });

  test("gültige Hosts und Wildcard-Subdomains bleiben erhalten", () => {
    expect(validateHosts(["registry.npmjs.org", "*.github.com", "luarocks.org"])).toEqual([
      "registry.npmjs.org",
      "*.github.com",
      "luarocks.org",
    ]);
  });

  test("env wird weitergegeben", () => {
    const env = buildEnv({ ...spec, env: { USAC_HOOK_LOG: "/tmp/hook.log" } }, { PATH: "/bin" });
    expect(env.USAC_HOOK_LOG).toBe("/tmp/hook.log");
    expect(env.PATH).toBe("/bin");
  });

  test("spec.env ueberschreibt process.env", () => {
    const env = buildEnv({ ...spec, env: { USAC_PROTECTOR_MODE: "blockieren" } }, { USAC_PROTECTOR_MODE: "lernen" });
    expect(env.USAC_PROTECTOR_MODE).toBe("blockieren");
  });

  test("Gate-Profile nennen ihre Registries", () => {
    const lua = YAML.parse(readFileSync(join(REPO_ROOT, "gate-profiles/lua.yaml"), "utf8"));
    const ts = YAML.parse(readFileSync(join(REPO_ROOT, "gate-profiles/typescript.yaml"), "utf8"));
    expect(lua.network_allow).toContain("luarocks.org");
    expect(ts.network_allow).toContain("registry.npmjs.org");
    expect(() => validateHosts(lua.network_allow)).not.toThrow();
    expect(() => validateHosts(ts.network_allow)).not.toThrow();
  });
});
