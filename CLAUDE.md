# US-AGENTIC-CODE – Arbeitsregeln fuer Claude Code

Dieses Repo ist US-AGENTIC-CODE (Kurzform `usac`): ein lokales Entwicklungsteam aus Claude-Code-Agents, ausgeliefert als Claude-Code-Plugin. Architektur-Spec: https://claude.ai/artifact/NL9NL5DZ4Dw2LUiC4yUgqD

Sprache: Antworten, Doku, Commit-Texte und Kommentare auf Deutsch. Bezeichner im Code auf Englisch.

## Befehle

- `bun install` – Abhaengigkeiten
- `bun test` – alle Tests (Pflicht vor jedem Commit)
- `bun test tests/acceptance` – Abnahmetests
- `bunx tsc -p tsconfig.json --noEmit` – Typecheck (Pflicht vor jedem Commit)
- `claude plugin validate .` – Plugin pruefen
- `bun packages/daemon/src/cli.ts <befehl>` – CLI `usac` (init, run, resume, status, events, approve, doctor)
- `bun scripts/gen-agents.ts` / `bun scripts/gen-schemas.ts` – Rollen bzw. JSON-Schemas neu erzeugen (nicht von Hand in `agents/` oder `schemas/` editieren)

## Regeln fuer die Arbeit an diesem Repo

1. **Rueckwaerts entwickeln.** Jede neue Faehigkeit beginnt mit einem Abnahmetest in `tests/acceptance/`, der zuerst rot ist. Erst dann implementieren, bis er gruen ist. Bestehende Abnahmetests nicht abschwaechen.
2. **Kein Raten.** Aussagen ueber Claude-Code-CLI, Graphify oder andere Werkzeuge nur mit Beleg (Hilfe-Ausgabe, Doku, Test). Unbekanntes als offene Frage in `docs/adr/` festhalten.
3. **Keine Zusatzkosten.** Nur Claude-Abo, vorhandenes GitHub und kostenlose Open-Source-Werkzeuge. Keine Cloud-Dienste, keine API-Keys.
4. **Kein Container-Zwang.** Isolation ueber Git-Worktrees, Claude-Code-Sandbox (bubblewrap/socat) und Protector-Hook. Plattform: Linux, Windows ueber WSL2.
5. **Orchestrator bleibt deterministisch.** Entscheidungen (Reihenfolge, Eskalation, Gates, Modellwahl) trifft Code, nie ein LLM.
6. **Schlank bleiben.** Neue Bausteine nur mit Begruendung als ADR in `docs/adr/`.
7. **Fremdcode:** `third_party/` bleibt unveraendert; Herkunft in `THIRD_PARTY.md`.

## Aufbau

- `packages/shared/src/index.ts` – zod-Schemas (Belege, Claims, Rollen-Ausgaben), Typen
- `packages/daemon/src/orchestrator.ts` – Bugfix-Workflow als Zustandsmaschine (setup → acceptance → approve_h1 → lock → implement → review → integrate)
- `packages/daemon/src/runner/` – `claude.ts` (echter Runner, stream-json), `scripted.ts` (Tests)
- `packages/daemon/src/{store,gates,integrity,evidence,routing,graph,prompts,config,exec}.ts`
- `packages/daemon/src/cli.ts` – CLI `usac`
- `hooks/` – Protector (PreToolUse), Delivery-Gate (Stop)
- `routing.yaml`, `gate-profiles/`, `workflows/`, `agents/`, `schemas/`, `commands/`
- `tests/acceptance/` – Abnahmetests je Phase; `tests/fixtures/lua-rotation` – Lua-Testprojekt; `tests/fixtures/fake-claude.ts` – nachgebautes claude-Binary

## Stand

Phase 0 ist gebaut und lokal getestet (30 Tests gruen), aber noch nicht mit echten Claude-Sessions gelaufen.

### Zuerst erledigen: offene Pruefpunkte aus ADR 0001

- [ ] Headless-Anmeldung: `claude setup-token`, dann `CLAUDE_CODE_OAUTH_TOKEN` setzen, `usac doctor`
- [ ] Echter Lauf am Fixture: Kopie von `tests/fixtures/lua-rotation` als Git-Repo, `usac init`, `usac run bugfix -t "Rotation ignoriert Cooldowns" --project <pfad>`; Event-Log pruefen (`usac events <id>`)
- [ ] Feldname der strukturierten Ausgabe im `result`-Event bestaetigen (`structured_output`), sonst `runner/claude.ts` anpassen
- [ ] Pfadregeln in `permissions` (`Edit(//abs/**)`) und Sandbox-Settings mit echter Session pruefen; Protector- und Delivery-Gate-Hook in echter Session ausloesen
- [ ] Pruefen, ob `fable` headless im Abo verfuegbar ist; Ergebnis in `routing.yaml`/ADR festhalten
- [ ] Danach: Rotation-Bot als erstes echtes Projekt (`usac init`, Gate-Profil Lua ggf. erweitern)

### Phase 1 (laut Spec): Pipeline und UI v1

- Workflow `feature` (Analyst, Tech Lead mit Rueckwaerts-Planung, Slice-Tests)
- Memory-DB v1 lokal (`~/.usac/memory.db`, FTS5, Belegpflicht, Status proposed/verified/stale) + Abgleich mit privatem GitHub-Repo `usac-memory` per pre-push-Hook
- Modell-Routing: Kontingent-Erfassung aus Token-Events, Freigabe fuer Fable ab 75 %
- UI v1: Inbox (Freigaben), Agent-Wand (laufende Runs), Run-Detail (Event-Log) per WebSocket
- Abnahme Phase 1: 5 Tasks am Rotation-Bot mergebar; Memory-Abgleich beim Push laeuft; UI v1 laeuft
