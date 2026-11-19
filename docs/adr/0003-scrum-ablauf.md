# ADR 0003: Scrum-Ablauf im Plugin (Entwurf)

Status: **Entwurf**
Datum: 2026-11-18
Bezug: `docs/adr/0002-phase-1-entwurf.md`, Regel 5 aus `CLAUDE.md` (Orchestrator deterministisch)

## Kontext

Das Team arbeitet agil. Der Ablauf im Plugin soll die Scrum-Rollen und -Termine abbilden, damit Planung, Fortschritt und Rückblick nachvollziehbar sind. Dabei gilt Regel 5: Reihenfolge, Gates und Eskalation entscheidet Code, nie ein Modell.

## Zuordnung der Rollen

| Scrum | Im Plugin | Wer |
|---|---|---|
| Product Owner | du, über Freigaben (H1, H2, Spec) und Priorität im Backlog | Mensch |
| Scrum Master | Orchestrator (deterministisch): Zeitraum-Grenzen, WIP-Limit, Eskalation | Code |
| Entwicklungsteam | Agents (Analyst, Tech Lead, Implementer, Reviewer, …) | Modelle, nach `routing.yaml` |
| Backlog | Work-Items im Store, sortiert nach deiner Priorität | Store |

## Termine

- **Zeitraum:** feste Zeitbox von 7 Tagen ab einem Startdatum (`periodStart`, `periodDays`). Die Zeiträume sind fest: Das Erreichen der Kontingent-Schwelle (ab 75 %, ADR 0002) beendet sie nicht. Länge ist konfigurierbar.
- **Planung je Zeitraum:** Der Orchestrator zieht Work-Items aus dem Backlog, bis die Kapazität erreicht ist. Kapazität = Kontingent-Budget des Zeitraums, nicht Stunden. Du bestätigst den Zeitraum (Freigabe).
- **Daily:** kein Meeting. Ein automatischer Statusbericht je Run aus dem Event-Log: erledigt, läuft, blockiert (Freigabe ausstehend oder Eskalation).
- **Review je Zeitraum:** Du prüfst die gemergten PRs und die offenen Freigaben im UI.
- **Retrospektive:** Die Learner-Rolle (Haiku) schlägt Lernregeln vor, aus Fehlversuchen und Eskalationen. Du entscheidest, ob sie übernommen werden. Keine Regel gilt ohne deine Freigabe.

## Definition of Done

Ein Work-Item ist fertig, wenn alle Punkte grün sind:

1. Gates des Gate-Profils grün (Stufen 1 bis 2 in Phase 1, später mehr).
2. Abnahmetests grün, gesperrte Tests unverändert (Hash-Prüfung).
3. Code-Review ohne offene `critical`- oder `high`-Befunde.
4. PR gemergt nach Freigabe H2.

Die Prüfung ist mechanisch. Ein Modell darf nicht selbst erklären, dass etwas fertig ist.

## Metriken (Vorbereitung für Phase 5)

- Velocity: abgeschlossene Work-Items und Token-Verbrauch je Zeitraum.
- Fehlversuche je Work-Item, Eskalationsrate.
- Freigabe-Wartezeit (wie lange ein Run auf dich wartet).

Die Metriken entstehen aus dem Event-Log. Es gibt keine zusätzlichen Datenquellen.

## Entscheidungen, die noch offen sind

1. Länge des Zeitraums: beantwortet mit 7 Tagen ab Startdatum (siehe Änderung).
2. Wer legt Work-Items an: du direkt, oder der Analyst aus einer Idee?
3. Dürfen Work-Items während eines laufenden Zeitraums in einen anderen wandern (Scope-Änderung)? Scrum sagt nein, es kann aber für Notfälle nötig sein.

## Nicht in diesem Schritt

Kein Code. Kein UI-Board. Das Board kommt mit UI v1 (Inbox und Agent-Wand), nicht als Jira-Ersatz.

## Änderung (2026-11-19)

Der Begriff Sprint entfällt. Ein Zeitraum ist eine feste Zeitbox von 7 Tagen ab einem Startdatum (`periodStart`, `periodDays`). Grund: Nutzerwunsch, „ordentlich dokumentieren wie im Entwickler-Alltag“, nicht Scrum.
