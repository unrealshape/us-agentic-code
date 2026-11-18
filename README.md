# US-AGENTIC-CODE

Ein eigenes Entwicklungsteam aus Claude-Code-Agents, als Plugin installiert und vollstaendig lokal. Ein deterministischer Orchestrator plant, verteilt, prueft und eskaliert; die Agents erledigen nur die eigentliche Arbeit. Entwickelt wird rueckwaerts: Zuerst steht ein roter Abnahmetest, der gesperrt wird, dann wird darauf hingebaut, bis er gruen ist. Agents raten nie: Jede Aussage braucht einen Beleg, der mechanisch geprueft wird. Ausser dem Claude-Abo entstehen keine Kosten.

## Stand: Phase 0 (Fundament)

| Baustein | Status |
| --- | --- |
| Bugfix-Workflow rueckwaerts (Abnahmetest rot → Freigabe → Sperre → Implementierung → Review → Commit) | fertig |
| Testsperre (Hash) und Anti-Schummel (Tests, Gate-Konfiguration, Skip-Marker) | fertig |
| Belegpflicht mit mechanischer Pruefung (Datei + Zeilen + Zitat, Gate, URL-Allowlist) | fertig |
| Modell-Routing Fable/Opus/Sonnet/Haiku mit Eskalation und Kontingent-Bremse | fertig |
| Event-Log (SQLite, nur anhaengen, Cursor) | fertig |
| Graphify-Graph je Auftrag (tree-sitter, ohne LLM) | fertig |
| Hooks: Protector (PreToolUse), Delivery-Gate (Stop) | fertig |
| Gate-Profile: Lua, TypeScript | fertig |
| 14 Rollen als Claude-Code-Agents | Prompts vorhanden, im Workflow genutzt: Test Engineer, Implementer, Code Reviewer |
| Memory-DB, UI, weitere Workflows | Phase 1+ |

## Voraussetzungen

Linux oder Windows mit WSL2. Bun, Git, Claude Code (Abo), Python 3.10+ fuer Graphify, bubblewrap und socat fuer die Sandbox. Pro Sprache die Werkzeuge des Gate-Profils (Lua: busted, luacheck; optional stylua).

Schritt-für-Schritt-Installation (Windows nativ und WSL2, mit Fehlersuche): [docs/installation.md](docs/installation.md).

```bash
bun install
bun packages/daemon/src/cli.ts doctor
```

## Installation als Plugin

```
/plugin marketplace add <dein-github>/us-agentic-code
/plugin install usac@us-agentic-code
/usac doctor
```

## Benutzung

```bash
usac init /pfad/zum/projekt                       # .usac/project.yaml + Graphify
usac run bugfix -t "Rotation ignoriert Cooldowns" -d "Zauber auf Cooldown duerfen nicht gewaehlt werden" --project /pfad/zum/projekt
usac status                                       # Auftraege und offene Freigaben
usac approve <freigabe-id>                        # Abnahmetest freigeben (H1)
usac resume <workitem-id>                         # weiterlaufen lassen
usac events <workitem-id>                         # vollstaendiges Event-Log
```

Ohne `--auto h1` wartet jeder Auftrag nach dem roten Abnahmetest auf deine Freigabe. Ergebnis ist ein Branch `usac/<id>` mit zwei Commits: `test: Abnahmetest …` und `fix: …`. `main` wird nie angefasst.

## Tests

```bash
bun test                     # alle Tests
bun test tests/acceptance    # Abnahmetests von Phase 0
bunx tsc --noEmit -p .       # Typecheck
```

Die Abnahmetests in `tests/acceptance/phase0.test.ts` wurden zuerst geschrieben und definieren, was Phase 0 koennen muss. Sie laufen gegen ein echtes Lua-Projekt (`tests/fixtures/lua-rotation`) mit echten Gates (busted, luacheck); nur die Agents werden durch einen ScriptedRunner ersetzt.

## Aufbau

```
.claude-plugin/     Plugin- und Marketplace-Manifest
agents/             14 Rollen
commands/           /usac
hooks/              Protector, Delivery-Gate
routing.yaml        Modell-Routing
gate-profiles/      lua.yaml, typescript.yaml
schemas/            JSON-Schemas der Rollen-Ausgaben (fuer --json-schema)
workflows/          bugfix.yaml
packages/shared     Typen und zod-Schemas
packages/daemon     Orchestrator, Runner, Gates, Belegpruefung, Routing, Store, CLI
third_party/ecc     unveraenderte Vorlagen aus ECC (MIT)
docs/adr            Architekturentscheidungen
```

Lizenz: MIT. Fremdcode und Ideen: siehe `THIRD_PARTY.md`.
