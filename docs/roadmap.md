# Roadmap (Entwurf)

Stand: Phase 0 weitgehend gebaut. Offen sind die WSL2-Prüfungen und der Rotation-Bot. Dieser Entwurf ordnet die Phasen 1 bis 5 und nennt je Phase die Abnahmetests, die zuerst rot sein müssen (Regel 1 aus `CLAUDE.md`). Jede Phase wird in eigenen Schritten umgesetzt. Die Reihenfolge folgt den Abhängigkeiten, nicht der Nummerierung.

## Abhängigkeiten

```
Phase 0 (Rest: WSL2, Rotation-Bot)
   └─ Phase 1  Pipeline + UI v1
        ├─ Phase 2  Queue, Leases, GateGuard, Doppel-Review
        ├─ Phase 3  Wissen (braucht Memory-DB aus Phase 1)
        └─ Phase 4  Volles Team, Gate-Stufen 3–6 (braucht Phase 2 für Parallelität)
             └─ Phase 5  Volle UI, Metriken, Modell-Herabstufung (braucht Metriken aus Phase 1–4)
```

## Phase 1: Pipeline und UI v1

Reihenfolge innerhalb der Phase:

1. **Workflow `feature`** (Analyst → Tech Lead mit Rückwärts-Planung → Slice-Tests).
   - Abnahmetest zuerst: `tests/acceptance/feature.test.ts`, z. B. „ein Feature wird in Slices geplant, jeder Slice hat einen roten Test“.
2. **Integrator** (Branch pushen, PR über `gh`, Freigabe H2 vor Merge).
   - Braucht ein GitHub-Remote. Offene Entscheidung: privates oder öffentliches Repo.
   - Abnahmetest: „nach Freigabe H2 wird der PR gemerged, ohne Freigabe nicht“.
3. **Memory-DB v1** (SQLite + FTS5, Belegpflicht, Status proposed/verified/stale) mit pre-push-Abgleich nach `usac-memory`. Dazu die Learner-Rolle.
   - Abnahmetest: „ein Eintrag ohne Beleg wird abgelehnt“, „Push synchronisiert nur verifizierte Einträge“.
4. **Kontingent**: Token-Summen aus den Events, Fable ab 75 % nur mit Freigabe.
   - Abnahmetest: „ab 75 % wird Fable ohne Freigabe nicht gerufen“.
5. **UI v1** (Hono + WebSocket): Inbox, Agent-Wand, Run-Detail.
   - Abnahmetest: „Inbox zeigt offene Freigaben, Run-Detail zeigt das Event-Log“.

## Phase 2: Sicherheit und Parallelität

- Queue und Scheduler für 3 parallele Runs.
- Datei-Leases mit Heartbeat: zwei Runs dürfen dieselbe Datei nie gleichzeitig ändern.
- GateGuard-Hook, Protector mit den Modi lernen / melden / blockieren, Netzwerk-Allowlist in der Sandbox.
- Doppel-Review mit Opus bei Größe `large` und bei Security-Triggern. Fable ist dafür nicht vorgesehen (Entscheidung 2026-11-18: nur Architektur).

Abnahmetests zuerst: „vier Runs gleichzeitig, nur drei laufen“, „zwei Runs auf derselben Datei werden serialisiert“, „ein Lease ohne Heartbeat wird nach Timeout frei“.

Benötigt: WSL2 (Sandbox, Netzwerk-Allowlist).

## Phase 3: Wissen

- Onboarding-Run erzeugt das Projektprofil, du bestätigst es.
- Pipeline für Wissenslücken: Memory → Graph → Code → Doku → Rückfrage an dich. Belege aus Graph und Memory werden prüfbar.
- Regel-Compiler: `CLAUDE.md` wird zu einer Verfassung mit Regel-Teilen.
- Lebenszyklus der Instincts (Lernregeln), ADR-Verwaltung, Team-Abgleich mit Konflikten in der Inbox.
- Gate-Profile und Stack-Skills für Python, Go, Rust, .NET, Java.

Abnahmetests zuerst: „eine Wissenslücke wird in dieser Reihenfolge geschlossen“, „ein Beleg aus dem Graph ist prüfbar“.

## Phase 4: Volles Team und Umgebungen

- Analyst, Architect, Security Reviewer, QA mit Playwright, Environment Engineer im Workflow.
- Gate-Stufen 3–6: E2E, Semgrep, gitleaks, Trivy, Coverage-Diff, Nachweise je Kriterium.
- Lokale Preview, eigene Test-Datenbank je Task.
- Workflows `new-project`, `change`, `refactor`, `dependency-update`, `security-fix`, `spike`.

Abnahmetests zuerst: pro Workflow ein Durchlauf von Anfang bis Ende.

## Phase 5: Volle UI und Steuerung

- Pipeline-Graph, Review-Ansicht mit Diff, Wissens-Ansicht, Metriken, Command-Palette (⌘K).
- Browser-Push als PWA, optionale Anbindung von Plane, Nachtbetrieb.
- Vorschläge zum Herabstufen von Modellen auf Basis der Metriken.

Später: Backup-Strategie und optionale Nutzung deines Servers.

## Entschiedene Fragen (2026-11-18)

1. **Repo:** `us-agentic-code` öffentlich auf GitHub, Autor `unrealshape`.
2. **Memory-Repo:** `usac-memory` privat, von Claude angelegt.
3. **Modelle:** Fable nur für sehr komplexe Architekturaufgaben (Rolle `architect`). Opus steuert (Analyst, Tech Lead, Code-Reviewer, Security-Reviewer). Der Rest läuft auf Haiku und Sonnet. Umgesetzt in `routing.yaml` (Abschnitt `fable.only_roles`) und `packages/daemon/src/routing.ts`.

4. **Merge:** automatisch nach Freigabe H2 (ADR 0002, Abschnitt 3).
5. **Kontingent:** Bezug ist das Abo Claude Max 20x (ADR 0002, Abschnitt 5).
6. **Memory v1:** nur FTS5, ohne Embeddings.
7. **spec/feature.md:** liegt im Ziel-Projekt.
8. **Arbeitsweise:** agil nach Scrum, Zuordnung in ADR 0003 (Entwurf).

Noch offen: Wer gibt die Fable-Freigabe ab 75 % Kontingent? Vorschlag: UI-Inbox, sobald Phase 1 steht. Offen in ADR 0003: Sprintlänge, Anlage der Work-Items, Scope-Änderungen im Sprint.

## Vorgehen je Phase

- Erst die Abnahmetests schreiben und rot sehen, dann implementieren.
- Eine ADR in `docs/adr/` für jeden neuen Baustein, der nicht schon im Spec steht (Regel 6).
- Vor jedem Commit: `bun test` und `bunx tsc -p tsconfig.json --noEmit`.
