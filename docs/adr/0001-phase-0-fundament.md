# ADR 0001: Fundament von Phase 0

Status: angenommen (2026-11-18)

## Kontext

US-AGENTIC-CODE loest Ruflo ab. Anforderungen: lokal, als Plugin, ohne Container und Zusatzkosten, rueckwaerts entwickeln, kein Raten, jede Sprache.

## Entscheidungen

1. **Deterministischer Orchestrator in TypeScript auf Bun.** Workflows sind Zustandsmaschinen; der Zustand liegt in SQLite (`~/.usac/usac.db`), nicht im Kontext eines Agents. Ein Auftrag kann nach jeder Phase fortgesetzt werden (`usac resume`).
2. **Agents laufen als `claude -p --output-format stream-json`** mit `--model`, `--json-schema` (strukturierte Ausgabe), `--append-system-prompt` (Rolle), `--settings` (Sandbox und Rechte je Run) und `--plugin-dir` (Hooks). Die Runner-Schnittstelle ist austauschbar; Tests nutzen einen ScriptedRunner.
3. **Turn-Limit im Runner.** Die CLI-Hilfe (2.1.327) nennt kein `--max-turns`; der Runner zaehlt Assistant-Turns im Stream und bricht ab.
4. **Rueckwaerts:** Der Abnahmetest muss rot sein (sonst abgelehnt), wird nach Freigabe H1 per SHA-256 gesperrt und als eigener Commit festgeschrieben. Der Implementer arbeitet gegen diesen Stand.
5. **Anti-Schummel per Diff**, nicht per Prompt: Aenderungen an gesperrten Tests, Testdateien, Gate-Konfiguration und neue Skip-Marker werden verworfen und zaehlen als Fehlversuch.
6. **Belegpflicht:** Rollen-Ausgaben werden mit zod validiert; Datei-Belege werden gegen Zeilen und Zitat geprueft. Ungueltige Belege machen die Ausgabe ungueltig.
7. **Graphify** baut je Auftrag den Graphen im Worktree (`graphify update .`, ohne LLM). `graphify-out/` steht in `.git/info/exclude` und wird nie committet.

## Noch zu verifizieren (vor dem ersten echten Lauf)

- Headless-Anmeldung ueber `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
- Feldname der strukturierten Ausgabe im `result`-Event (`structured_output`); Fallback: JSON aus dem Ergebnistext.
- Syntax der Pfadregeln in `permissions` (`Edit(//abs/pfad/**)`) und Schluessel der Sandbox-Settings.
- Verfuegbarkeit von `fable` headless im Abo; sonst greift der Rueckfall in `routing.yaml`.
