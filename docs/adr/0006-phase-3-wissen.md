# ADR 0006: Phase 3 – Wissen

Status: **Entwurf** (Schemas gebaut; Bausteine folgen in den Tasks 2 bis 11 des Plans)
Datum: 2026-11-18
Bezug: `docs/roadmap.md` (Phase 3), `docs/adr/0002-phase-1-entwurf.md` (Abschnitt 4 Memory), `docs/adr/0003-scrum-ablauf.md` (Retrospektive, Learner), `THIRD_PARTY.md` (Regel-Compiler-Idee aus Ruflo, continuous-learning-v2 aus ECC), Plan `docs/superpowers/plans/2026-11-18-phase-3.md`

## Kontext

Das Team soll ein Projekt kennenlernen (Onboarding mit bestätigtem Profil), Wissenslücken mit prüfbaren Belegen schließen, `CLAUDE.md` als Verfassung nutzen, aus Fehlern lernen und Wissen im Team teilen. Regel 6 („Schlank bleiben“) verlangt für jeden neuen Baustein eine Begründung. Regel 5 verlangt, dass Entscheidungen im Code fallen: Explorer und Learner liefern nur Vorschläge.

## Gemeinsame Grundlage

Alle Wissensquellen liefern Fundstellen als `Evidence` und laufen durch dieselbe Belegprüfung (`checkEvidence`) wie Rollen-Ausgaben. Neu in `packages/shared/src/index.ts`:

- `GraphEvidence = { type: "graph", node_id, path, lines, quote }` als Teil von `Evidence`. Bis Task 2 lehnt `checkEvidence` Graph-Belege ab („Graph-Belege sind noch nicht pruefbar“).
- `ExplorerOutput` (Sprachen, Befehle, höchstens 10 Konventionen als `Claim` mit Stufe), `LearnerOutput` (höchstens 3 `InstinctProposal` mit mindestens einer Ereignis-ID, höchstens 5 `MemoryProposal` mit mindestens einem Datei-Beleg), beide in `ROLE_OUTPUTS`.
- `WorkItemType` um `onboarding` erweitert.
- Die JSON-Schemas (`schemas/*.schema.json`, erzeugt von `scripts/gen-schemas.ts`) kennen zusätzlich die Beleg-Varianten `graph` und `memory`.

## Bausteine

| Baustein | Datei(en) | Begründung |
|---|---|---|
| Lückensuche | `packages/daemon/src/knowledge.ts` | Feste Reihenfolge Memory → Graph → Code → Doku → Rückfrage als reine Funktion; fehlt eine Quelle (z. B. kein `graph.json`), Event `gap.source_unavailable` und weiter mit der nächsten Quelle. Ersetzt freies Suchen der Rollen durch eine prüfbare Kette. |
| Regel-Compiler | `packages/daemon/src/rules.ts` | Macht aus `<projekt>/CLAUDE.md` eine Verfassung aus Kernregeln und rollenbezogenen Regel-Teilen mit Zeilen-Belegen. Rollen bekommen nur die für sie relevanten Regeln; Codeblöcke sind keine Regeln. |
| Instincts | `packages/daemon/src/instincts.ts`, `packages/daemon/src/learn.ts` | Kurze, belegte Verhaltensregeln je Rolle aus Fehlschlägen (Learner schlägt vor). Lebenszyklus mit Freigabe, Nutzungszählung und Stilllegung, damit wirkungslose Regeln verschwinden. |
| ADR-Verwaltung | `packages/daemon/src/adr.ts`, `packages/daemon/src/adr-check.ts` | Liest ADRs im Ziel-Projekt und prüft, dass neue Abhängigkeiten ein ADR haben (Befund im Review). Überträgt Regel 6 auf Ziel-Projekte. |
| Team-Abgleich | `packages/daemon/src/sync.ts` | Gleicht Memory mit dem privaten Repo `usac-memory` ab; Konflikte landen als Freigabe in der Inbox statt still überschrieben zu werden. |

## Standardwerte (aus „Offene Entscheidungen“ des Plans)

Diese Werte gelten, bis der Nutzer anders entscheidet. Jeder Wert ist eine Konstante im genannten Modul.

1. **Onboarding:** fester Ablauf in `onboarding.ts` mit Auftragstyp `onboarding`, außerhalb der Workflow-Dateien, weil `run()` ein vorhandenes Profil voraussetzt.
2. **Fragen blockieren nicht:** Freigabe `question` läuft nebenher, die Rolle arbeitet mit `UNKNOWN` weiter; höchstens 2 Suchrunden.
3. **Schlüsselwörter und Treffer:** Wörter ab 4 Zeichen ohne Stoppwörter, höchstens 6; Treffer bei mindestens 2 Schlüsselwörtern in einer Zeile; höchstens 5 Treffer je Quelle.
4. **Quelle des Regel-Compilers:** nur `<projekt>/CLAUDE.md`; die private `~/.claude/CLAUDE.md` nie.
5. **Kern und Teile:** höchstens 15 Kernregeln; Teile werden nach Stichworten der Überschrift den Rollen zugeordnet.
6. **Instinct-Schwellen:** Stilllegung ab 5 Nutzungen, wenn mindestens 3 und mindestens die Hälfte davon Wiederholungen des Fehlers zeigen; höchstens 10 Instincts im Prompt; Learner höchstens 3 Vorschläge je Lauf.
7. **Wann der Learner läuft:** nur nach Läufen mit Eskalation, Anti-Schummel-Verstoß, Review-Rückweisung oder Implementer-Fehlversuchen.
8. **ADR-Pflicht in Ziel-Projekten:** an (`adr.require_for_dependencies: true`), Befund `high`.
9. **Zeitpunkt des Team-Abgleichs:** `usac memory pull` von Hand und beim Start von `usac daemon`; Instincts werden nicht abgeglichen.
10. **Konflikt:** gleiche UID mit anderem Status, oder überlappender Beleg-Anker mit anderem Text bei beiden `verified`.
11. **Antworten des Nutzers:** als `verified` mit Freigabe-Beleg, nur lokal, nie exportiert.
12. **Rot durch Build-Fehler:** zählt als rot, wird aber als `acceptance:build_error` markiert und bei H1 angezeigt.
13. **Java und .NET:** Java nur Maven, .NET nur `dotnet`-CLI (Details in ADR 0007).

Keine Regel und kein Instinct gilt ohne Freigabe durch den Nutzer (ADR 0003). Explorer und Learner laufen auf Haiku (`routing.yaml`).

## Rollen

- **Explorer:** liefert Konventionen nur mit Datei-Beleg; ohne Beleg Stufe `UNKNOWN` und eine Frage.
- **Learner:** schlägt vor, entscheidet nie. Übernahme entscheiden Code (Schwellen, Belegprüfung) und Nutzer (Freigabe).

## Offene Fragen

- **Graph-Format von `graph.json`:** Welche Felder nennen in `graphify-out/graph.json` Knoten-ID, Label, Quelldatei und Zeile? Nicht geraten (Regel 2). Beantwortet wird die Frage durch `tests/fixtures/graph/QUELLE.md` aus Task 2 (Graphify-Version, Befehl, Datum, Feldnamen aus einem echten Lauf unter Linux/WSL2). Bis dahin sind Graph-Belege nicht prüfbar und die Lückensuche überspringt den Graph.

## Folgen

- Rollen-Ausgaben mit `graph`- oder `memory`-Belegen sind schema-gültig, werden aber bis Task 2 bzw. Task 3 von der Belegprüfung abgelehnt.
- Neue Bausteine sind reine Funktionen oder SQLite-Module ohne LLM; das hält den Orchestrator deterministisch.
