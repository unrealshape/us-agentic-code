# ADR 0005: Netzwerk-Allowlist in der Sandbox

Status: **Entwurf** (Schlüssel belegt aus der Doku; echte Session unter WSL2 steht aus)
Datum: 2026-11-18
Bezug: `docs/adr/0004-phase-2-parallelitaet-sicherheit.md`, Regel 2 („Kein Raten“) und Regel 4 (Sandbox statt Container) aus `CLAUDE.md`

## Kontext

Die eingebaute Bash-Sandbox von Claude Code (bubblewrap + socat) ist je Run eingeschaltet (`buildSettings` in `packages/daemon/src/runner/claude.ts`). Bisher war nicht festgelegt, welche Hosts Bash-Befehle erreichen dürfen. Gate-Profile brauchen ihre Paket-Registry (LuaRocks, npm), alles andere soll gesperrt sein. Außerdem sollen Hooks (Protector, GateGuard) je Run eigene Umgebungsvariablen bekommen (`USAC_PROTECTOR_MODE`, `USAC_HOOK_LOG`, `USAC_GATEGUARD`).

## Belege (Regel 2)

CLI-Version beim Nachlesen: `claude --version` → `2.1.327 (Claude Code)`, abgerufen am 2026-11-18.

1. **Domain-Allowlist:** <https://code.claude.com/docs/en/sandboxing> zeigt als Beispiel
   `{"sandbox": {"enabled": true, "network": {"allowedDomains": ["github.com", "*.npmjs.org"]}}}`
   und sagt: „Your allowed domains start empty.“ Der Settings-Index (<https://code.claude.com/docs/en/settings-reference>) führt `sandbox.network.allowedDomains` mit „Pre-allow domains so sandboxed commands don't prompt for them“, Scope „Any file“.
   → `NETWORK_KEY_PATH = ["sandbox", "network", "allowedDomains"]`.
2. **Ablehnen statt Nachfragen:** Laut Sandboxing-Doku gilt: „if you set `strictAllowlist` to `true` in user, managed, or CLI `--settings` settings, Claude Code denies sandboxed commands access to any host outside the allowlist instead of prompting“ (ab v2.1.219). Wir übergeben die Settings per `--settings`, also greift der Schlüssel. Ohne ihn würde in `acceptEdits` nachgefragt; headless antwortet niemand.
   → `sandbox.network.strictAllowlist = true` in jedem Run.
3. **Umgebung für Hooks:** <https://code.claude.com/docs/en/hooks>: „A hook process inherits the parent environment, apart from the `OTEL_*` exporter variables …“ und „Handlers run in the current directory with Claude Code's environment.“
   → Es genügt, die Variablen beim Start von `claude` in die Prozessumgebung zu legen (`env: { ...process.env, ...spec.env }`). Ein `env`-Block in den Settings ist nicht nötig.

Nicht belegt und daher nicht genutzt: Verhalten von `claude -p` bei nicht erlaubten Hosts ohne `strictAllowlist` (die Doku beschreibt nur interaktive Sitzungen).

## Entscheidung

- `RunSpec.networkAllow?: string[]` landet unter `NETWORK_KEY_PATH`. Fehlt die Liste oder ist sie leer, steht dort `[]` (kein Netz), nie ein fehlender Schlüssel.
- `validateHosts` lässt nur Domainnamen nach `^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$` zu und wirft sonst `Ungültiger Host in network.allow: <h>`. Damit sind `*`, URLs mit Schema, Ports und leere Einträge ausgeschlossen; ein Tippfehler öffnet nicht das ganze Netz.
- `RunSpec.env?: Record<string, string>` geht zusätzlich zu `process.env` an den Kindprozess (`buildEnv`), `spec.env` gewinnt.
- Gate-Profile nennen ihre Registry im Feld `network_allow`: `lua.yaml` → `luarocks.org`, `typescript.yaml` → `registry.npmjs.org`.

## Prüfung

- `packages/daemon/test/sandbox-settings.test.ts` (alle Plattformen): Schlüsselpfad, leere Liste, `strictAllowlist`, ungültige Hosts, `env`, Registries der Gate-Profile. Grün am 2026-11-18 unter Windows.
- `tests/acceptance/sandbox-network.test.ts` (nur Linux/WSL2 mit `USAC_SANDBOX_TESTS=1`): echte Haiku-Session, `curl https://example.com` gesperrt, `curl -I https://registry.npmjs.org` mit Allowlist erreichbar.
  **Offen:** noch nicht unter WSL2 gelaufen. Ergebnis mit Datum hier eintragen.

## Offene Punkte

- Verdrahtung: Noch kein Aufrufer setzt `networkAllow` oder `env`. Die Vereinigung aus `GateProfile.network_allow` und `ProjectProfile.network.allow` sowie `USAC_PROTECTOR_MODE`, `USAC_HOOK_LOG`, `USAC_GATEGUARD` muss der Orchestrator beim Bau des `RunSpec` setzen (eigener Task).
- Werkzeuge, die die Proxy-Variablen ignorieren (laut Doku z. B. `ssh`, die meisten Datenbank-Treiber), erreichen auch erlaubte Hosts nicht. `luarocks` und `npm` nutzen HTTP(S); unter WSL2 zu bestätigen.
- Ob LuaRocks für Downloads weitere Hosts braucht (Mirrors, GitHub-Quellen in Rockspecs), ist ungeprüft.
