# ADR 0008: Phase 4 – volles Team, Gate-Stufen 3–6, Preview, Test-Datenbank und Workflows

Status: **Entwurf** (Standardwerte gesetzt; Werkzeugbelege für Stufen 3 und 4 folgen in ADR 0009)
Datum: 2026-11-18
Bezug: `docs/superpowers/plans/2026-11-18-phase-4.md`, `docs/roadmap.md` (Phase 4), ADR 0003 (Definition of Done, Stufen), `routing.yaml` (Fable-Regel, Kontingent), Regeln 1–7 aus `CLAUDE.md`

## Kontext

Bis Phase 3 arbeiten Analyst, Tech Lead, Test Engineer, Implementer, Code Reviewer, Explorer und Learner in den Workflows `bugfix`, `feature` und `onboarding`. Architect, QA Engineer und Environment Engineer existieren nur als Rollentexte ohne strukturierte Ausgabe; der Security Reviewer nutzt das Review-Schema. Die Gate-Stufen 3–6 (E2E, Sicherheitswerkzeuge, Coverage-Diff, Nachweis je Kriterium) fehlen, ebenso eine lokale Preview, eine Test-Datenbank je Aufgabe und die Workflows `new-project`, `change`, `refactor`, `dependency-update`, `security-fix` und `spike`.

## Entscheidung

### Bausteine

| Baustein | Ort | Zweck |
|---|---|---|
| Rollen-Ausgaben | `packages/shared/src/index.ts` (`ArchitectOutput`, `QaOutput`, `EnvironmentOutput`), `schemas/*.schema.json` | Strukturierte, geprüfte Ausgaben der neuen Rollen |
| Auftragstypen | `WorkItemType` | `bugfix`, `feature`, `change`, `refactor`, `new-project`, `dependency-update`, `security-fix`, `spike`, `onboarding` |
| Coverage-Diff (Stufe 5) | `packages/daemon/src/coverage-diff.ts` | Anteil abgedeckter geänderter Zeilen aus lcov |
| Nachweis je Kriterium (Stufe 6) | `packages/daemon/src/criteria-evidence.ts` | Jedes `AC-n` hat einen grünen Test mit Marke |
| Lokale Preview | `packages/daemon/src/preview.ts` | Dev-Server je Aufgabe, ohne Container, mit PID-Datei und Aufräumen |
| Test-Datenbank | `packages/daemon/src/testdb.ts` | Eigene Datenbank je Aufgabe (SQLite, lokales PostgreSQL) |
| Gate-Stufen 3–6 | `packages/daemon/src/gates.ts`, `gate-profiles/` | E2E, Semgrep/gitleaks/Trivy, Stufen 5 und 6; Pflicht je Workflow |
| Team-Phasen | `packages/daemon/src/team-phases.ts` | `design`, `environment`, `qa`, `security`, `verify`, Charakterisierung, `research` |
| Workflow-Bedingungen | `packages/daemon/src/workflow.ts`, `workflows/*.yaml` | Phasen mit Bedingung (`when`) |

### Rollen

- **Architect** schlägt vor, entscheidet nicht: mindestens zwei Optionen mit Vor- und Nachteilen, eine Empfehlung (`decision`), Risiken, optional ein ADR-Entwurf. Die Datei unter `docs/adr/` schreibt der Orchestrator nach menschlicher Freigabe. Der Architect hat nur Lesewerkzeuge.
- **Spike** hat keine eigene Ausgabe: die Phase `research` nutzt die Rolle `architect` mit `ArchitectOutput` (ohne `adr`, Befunde in `claims`, Empfehlung in `decision`). Ein Typ `SpikeReport` wird nicht angelegt.
- **QA Engineer** schreibt nur E2E-Tests unter den `test_globs` des Gate-Profils, nennt sie (`e2e_tests`, mindestens einer) und die abgedeckten Kriterien (`criteria`, AC-IDs).
- **Environment Engineer** ändert nie Testdateien und nie `.usac/**`; er nennt geänderte Dateien und Einrichtungsbefehle (`setup_commands`).
- **Security Reviewer** behält das Review-Schema. Das Modell in `agents/security-reviewer.md` steht auf `opus`, passend zu `routing.yaml` (Fable nur für `architect`).

### Standardwerte (aus „Offene Entscheidungen“ des Plans)

1. **Coverage-Format:** nur lcov; Schwelle 0,8 der geänderten ausführbaren Zeilen. Stacks ohne lcov-Ausgabe bekommen keine Stufe 5, bis ein Konverter belegt ist.
2. **Nachweis je Kriterium:** Marke `[AC-n]` im Testtext plus grünes Slice-Gate. Ob der Test das Kriterium wirklich prüft, deckt nur H1 (menschliche Sichtung) ab.
3. **Semgrep-Regeln:** `--config p/default --metrics=off`; Regeln kostenlos aus der Semgrep-Registry. Folge: Netzzugriff auf einen Drittanbieter je Lauf; Alternative wären eigene Regeln im Repo.
4. **Pflichtwerkzeuge:** Stufe 4 ist nur in `security-fix` und `dependency-update` Pflicht, sonst optional. Ein fehlendes Pflichtwerkzeug lässt das Gate scheitern, nicht `skipped`.
5. **QA und Preview:** `qa` läuft nur bei konfigurierter Preview; rote E2E-Tests führen zurück zu `implement`. Projekte ohne Preview haben keine E2E-Abdeckung.
6. **Test-DB-Arten:** SQLite und lokales PostgreSQL über `createdb`/`dropdb`; kein MySQL, kein Docker.
7. **Spike:** nur lesend; Bericht `docs/spikes/<id>.md` geht per PR nach H2 in `main`. Prototyp-Code geht verloren; wer ihn behalten will, startet `change`.
8. **dependency-update:** kein roter Abnahmetest; Beweis sind grüne Stufen 1–4.
9. **refactor:** Charakterisierungstests müssen grün sein; Coverage-Diff gilt wie überall.
10. **new-project:** `usac new-project` legt nur ein lokales Repo an; das GitHub-Remote richtet der Nutzer selbst ein. `push` scheitert mit klarer Meldung, bis ein Remote existiert.
11. **Fable-Freigabe ab 75 %:** Inbox-Freigabe `fable`, blockierend; abgelehnt → Opus. Schließt die offene Roadmap-Frage „Wer gibt die Fable-Freigabe?“.
12. **Design-Freigabe:** immer menschlich, nicht per `--auto` überspringbar.
13. **Phase `verify`:** einmal nach `implement`/`qa` mit Stufen 3–6; ein Fehler zählt als Implementer-Fehlversuch. Teure Werkzeuge laufen bei jedem Rücksprung erneut.
14. **Playwright-Browser:** Stufe 3 optional, solange Playwright oder seine Browser fehlen; sichtbar als `skipped`.

## Folgen

- Neue Rollen-Ausgaben werden wie bisher über `bun scripts/gen-schemas.ts` und `bun scripts/gen-agents.ts` erzeugt; ein Test (`packages/daemon/test/phase4-schemas.test.ts`) prüft zod und JSON-Schemas.
- Keine neuen Laufzeit-Abhängigkeiten in diesem Schritt. Playwright, Semgrep CE, gitleaks und Trivy sind kostenlose Open-Source-Werkzeuge außerhalb des Repos; ihre Befehle werden in ADR 0009 belegt.
- Auftragstypen ohne eigene Workflow-Datei laufen bis Task 8 weiter als `bugfix` (`workflowFor` in `orchestrator.ts`).

## Offene Fragen

1. Alle Werkzeugbefehle der Stufen 3 und 4 (Playwright, Semgrep, gitleaks, Trivy) sind **ungeprüft**, bis sie gegen `--help` bzw. Doku der installierten Version belegt sind (ADR 0009).
2. `createdb`/`dropdb`: Verhalten ohne laufenden PostgreSQL-Server und unter Windows ohne WSL2 **ungeprüft**.
3. Semgrep `p/default` braucht Netz; ob das mit `network_allow` der Sandbox (ADR 0005) zusammenpasst, ist **ungeprüft**.
