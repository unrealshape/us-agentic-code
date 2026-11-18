/**
 * Abnahmetest Phase 2, Task 6: Netzwerk-Allowlist der Sandbox in echter Session.
 *
 * Nur Linux/WSL2 mit USAC_SANDBOX_TESTS=1: braucht die eingebaute Bash-Sandbox
 * (bubblewrap + socat), eine echte Haiku-Session ueber das Abo und Netz.
 * Auf Windows und ohne die Variable wird der Block uebersprungen, nicht abgeschwaecht.
 */
import { describe, expect, test } from "bun:test";
import { setupProject } from "../helpers";
import { ClaudeRunner } from "../../packages/daemon/src/runner/claude";

const ENABLED = process.platform === "linux" && process.env.USAC_SANDBOX_TESTS === "1";
const TIMEOUT = 5 * 60_000;

const ausgabePrompt = (cmd: string) =>
  `Führe genau diesen Bash-Befehl aus: \`${cmd}\`. Gib danach die vollständige Ausgabe (stdout und stderr) und den Exit-Code wörtlich wieder. Ändere keine Dateien.`;

describe.skipIf(!ENABLED)("Sandbox-Netzwerk (nur WSL2/Linux, USAC_SANDBOX_TESTS=1)", () => {
  test(
    "nicht erlaubter Host ist gesperrt",
    async () => {
      const cwd = setupProject();
      const r = await new ClaudeRunner({ sandbox: true }).run({
        role: "developer",
        model: "haiku",
        cwd,
        prompt: ausgabePrompt("curl -sS https://example.com"),
        networkAllow: [],
        allowedTools: ["Bash"],
        timeoutMs: TIMEOUT,
        maxTurns: 6,
      });
      const text = r.text ?? r.error ?? "";
      expect(text).not.toContain("Example Domain");
      expect(text).toMatch(/curl: \(\d+\)|403|blocked|denied|not allowed|refused|Exit-Code:?\s*[1-9]/i);
    },
    TIMEOUT + 10_000,
  );

  test(
    "erlaubter Host ist erreichbar",
    async () => {
      const cwd = setupProject();
      const r = await new ClaudeRunner({ sandbox: true }).run({
        role: "developer",
        model: "haiku",
        cwd,
        prompt: ausgabePrompt("curl -sSI https://registry.npmjs.org"),
        networkAllow: ["registry.npmjs.org"],
        allowedTools: ["Bash"],
        timeoutMs: TIMEOUT,
        maxTurns: 6,
      });
      const text = r.text ?? r.error ?? "";
      expect(text).toMatch(/HTTP\/[\d.]+ \d{3}/);
    },
    TIMEOUT + 10_000,
  );
});
