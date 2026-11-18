# ADR 0002: Phase 1 – Entwurf

Status: **Entwurf** (noch nicht umgesetzt, noch nicht entschieden)
Datum: 2026-11-18
Bezug: `docs/roadmap.md`, `docs/adr/0001-phase-0-fundament.md`

## Kontext

Phase 0 kann nur den Workflow `bugfix` und endet mit einem lokalen Commit. Der Orchestrator ist eine feste Zustandsmaschine in `packages/daemon/src/orchestrator.ts` (Phasen `setup → acceptance → approve_h1 → lock → implement → review → integrate → done`). Für `feature` und den Integrator mit PR muss die Maschine aus den Workflow-Dateien (`workflows/*.yaml`) gelesen werden, sonst gibt es für jeden Workflow eine eigene Schleife.

## Entscheidungen (Vorschlag)

### 1. Workflows als Daten, Orchestrator als Interpreter

- `workflows/feature.yaml` beschreibt die Phasen. Der Orchestrator führt sie aus, die Reihenfolge und die Gates stehen im Code nur einmal.
- Vorteil: `bugfix` und `feature` nutzen dieselben Gates, Freigaben und Eskalationen.
- Risiko: Die Refaktorierung trifft die bestehende Phase-0-Logik. Deshalb zuerst die Phase-0-Abnahmetests grün halten, dann umbauen.

### 2. Workflow `feature`

Phasen (Vorschlag):

1. `setup`: Worktree und Branch `usac/<id>`.
2. `spec`: Rolle `analyst` liefert die Spec als strukturierte Ausgabe (Kriterien, Nicht im Umfang, offene Fragen). Der Analyst schreibt **keine Datei** (nur `Read, Grep, Glob`); der Orchestrator rendert daraus deterministisch `spec/feature.md`.
3. `approve_spec`: Freigabe durch dich, neue Freigabe-Art `spec`. `--auto spec` ist erlaubt, wirkt aber nur ohne offene Fragen. Erteilt: die Spec wird committet (`docs: Spec für "<titel>"`); ist sie beim Wiedereintritt schon committet, wird der vorhandene Commit übernommen (kein leerer Commit). Abgelehnt: zurück zu `spec` mit der Notiz, die dritte Ablehnung eskaliert.
4. `plan`: Rolle `tech-lead` plant rückwärts in Slices. Jeder Slice bekommt eine Akzeptanzbedingung. Der Plan wird mechanisch geprüft (`checkPlan`).
5. `acceptance` je Slice: `test-engineer` schreibt rote Tests (wie bei `bugfix`). Fehlt beim Wiedereintritt ein Test eines erledigten Slices, eskaliert der Auftrag.
6. `approve_h1`: Freigabe der Slice-Tests.
7. `lock`: Hash sperren, pro Slice.
8. `implement` je Slice: bis Gates grün, Fehlversuche wie gehabt.
9. `review`: `code-reviewer`, frischer Kontext.
10. `integrate`: siehe Abschnitt Integrator.

Stand 2026-11-18: Die Handler für `spec`, `approve_spec` und `plan` sind in `registry-setup.ts` registriert; `feature` läuft mit echten Handlern bis zur Freigabe H1 (`tests/acceptance/feature-h1.test.ts`). **Review-Befund I1 geschlossen.** `--auto` erlaubt nur `h1` und `spec`.

### 3. Integrator mit PR und Freigabe H2

- Phasen nach `integrate`: `push` (Branch pushen), `pr` (PR über `gh pr create`), `approve_h2` (deine Freigabe), `merge` (`gh pr merge`).
- Regel: **nie direkt auf `main` pushen**, nur über PR. Merge erst nach `approve_h2`.
- Der Integrator-Agent bleibt Haiku (laut `routing.yaml`). Er formuliert nur die PR-Beschreibung. Die Entscheidung „merge ja/nein“ trifft der Code, nicht das Modell (Regel 5).
- Entschieden (2026-11-18): Der Merge läuft automatisch, sobald H2 erteilt ist. Es gibt keinen zweiten Befehl.

### 4. Memory-DB v1

- Lokal in SQLite (`~/.usac/memory.db`), FTS5 für Volltextsuche.
- Schema-Entwurf: `entries(id, kind, text, status, created_at)`, `evidence(entry_id, file, lines, quote)`.
- Status: `proposed | verified | stale`. Ein Eintrag ohne Beleg wird nicht gespeichert (Belegpflicht).
- Abgleich mit `usac-memory` (privat) über einen `pre-push`-Hook: nur `verified`-Einträge werden exportiert.
- Learner-Rolle (Haiku) schlägt Einträge vor, verifiziert werden sie mechanisch (Beleg prüfen), nicht vom Modell.

### 5. Kontingent

- Token-Summen aus den `run.finished`-Events, pro Monat.
- Fable-Freigabe ab 75 %: nach `routing.yaml`. Gilt nur für `architect` (Entscheidung 2026-11-18).
- Entschieden (2026-11-18): Bezugsgröße ist das Abo **Claude Max 20x**. Die 100 % kommen aus dessen Kontingent.
  - Offen: Der Zähler dafür muss aus den Events kommen. Ob die CLI das Kontingent selbst ausgibt, ist nicht geprüft. Bis dahin: eigene Token-Obergrenze, konfigurierbar, mit einem Kalibrierungslauf.

### 6. UI v1

- Hono mit WebSocket, lokal an `localhost`.
- Inbox (offene Freigaben), Agent-Wand (laufende Runs), Run-Detail (Event-Log).
- Neue Abhängigkeit (Hono): kostenlos, MIT. Muss als ADR-Begründung bleiben (Regel 6).

## Abnahmetests (zuerst rot)

Pro Entscheidung ein Test in `tests/acceptance/`:

- `feature.test.ts`: „ein Feature wird in Slices geplant, jeder Slice hat einen roten Test“.
- `integrator.test.ts`: „ohne H2 kein Merge“, „nie Push auf `main`“.
- `memory.test.ts`: „Eintrag ohne Beleg wird abgelehnt“, „Push exportiert nur `verified`“.
- `quota.test.ts`: „ab 75 % wird Fable ohne Freigabe nicht gerufen“.
- `ui.test.ts`: „Inbox zeigt offene Freigaben“.

### 7. Scrum-Ablauf

Die Arbeitsweise ist agil. Die Zuordnung zu Scrum steht in ADR 0003 (Entwurf).

## Entschiedene Fragen (2026-11-18)

1. Merge: automatisch nach Freigabe H2 (siehe Abschnitt 3).
2. Kontingent: Bezug ist das Abo Claude Max 20x (siehe Abschnitt 5).
3. Memory v1: nur FTS5, ohne Embeddings. Embeddings kommen später, wenn FTS5 nicht reicht.
4. `spec/feature.md` liegt im **Ziel-Projekt**, nicht im Plugin-Repo.

## Offene Fragen

- Wie zählt die CLI das Kontingent des Abos? (Siehe Abschnitt 5, noch nicht geprüft.)

## Nicht in Phase 1

Queue, Leases, GateGuard (Phase 2). Wissens-Pipeline, Regel-Compiler (Phase 3). Analyst-Rolle im Vollbetrieb, E2E, Semgrep (Phase 4).
