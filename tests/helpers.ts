import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const REPO_ROOT = resolve(import.meta.dir, "..");

/** Kopiert eine Fixture in ein frisches Git-Repo und gibt den Pfad zurueck. */
export function setupProject(fixture = "lua-rotation"): string {
  const dir = mkdtempSync(join(tmpdir(), `usac-${fixture}-`));
  cpSync(join(REPO_ROOT, "tests/fixtures", fixture), dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@usac.local");
  git("config", "user.name", "usac-test");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: initial");
  return dir;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "usac-home-"));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function write(path: string, content: string): void {
  writeFileSync(path, content);
}

/** Lua-Abnahmetest, den die Test-Engineer-Rolle im Szenario schreibt. */
export const ACCEPTANCE_SPEC = `local rotation = require("rotation")

describe("Abnahme: Cooldown", function()
  it("waehlt keinen Zauber, der auf Cooldown ist", function()
    local spells = {
      { name = "Pyroblast", priority = 10, cooldown = 5 },
      { name = "Fireball", priority = 5, cooldown = 0 },
    }
    assert.are.equal("Fireball", rotation.next_spell(spells))
  end)
end)
`;

/** Korrekte Implementierung, die die Implementer-Rolle im Szenario schreibt. */
export const FIXED_ROTATION = `local M = {}

--- Gibt den Namen des naechsten Zaubers zurueck.
-- @param spells table Liste von { name = string, priority = number, cooldown = number }
-- @return string|nil
function M.next_spell(spells)
  local best
  for _, spell in ipairs(spells) do
    local ready = (spell.cooldown or 0) <= 0
    if ready and (best == nil or spell.priority > best.priority) then
      best = spell
    end
  end
  return best and best.name or nil
end

return M
`;
