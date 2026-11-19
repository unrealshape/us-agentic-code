# ADR 0010: Phase 5 – volle UI, PWA, Nachtbetrieb, Plane, Herabstufung

Status: **Entwurf**
Datum: 2026-11-18
Bezug: `docs/superpowers/plans/2026-11-18-phase-5.md`, ADR 0002 (UI v1, Hono), ADR 0003 (Scrum-Ablauf, Metriken, Zeitraum), Regeln 2, 3, 5 und 6 aus `CLAUDE.md`

## Kontext

Phase 5 erweitert die UI v1 zu einer vollen Steuerungsoberfläche und nutzt das Event-Log für Metriken und Vorschläge zur Modellwahl. Regel 6 verlangt für neue Bausteine ein ADR. Neue npm-Abhängigkeiten gibt es nicht.

## Entscheidung: Bausteine

| Baustein | Datei | Kurzbeschreibung |
|---|---|---|
| Metriken | `packages/daemon/src/metrics.ts` | Reine Funktion `computeMetrics` über das Event-Log: Velocity und Eskalationsrate je Zeitraum, Tokens, Fehlversuche je Auftrag, Erstversuchs-Quote und Turns je Rolle und Modell, Wartezeit auf Freigaben. Keine zusätzliche Datenquelle (ADR 0003). |
| Herabstufung | `packages/daemon/src/downgrade.ts`, `routing.ts` | Vorschläge nach festen Schwellen, Übernahme nur als Freigabe, Override in `<home>/routing.override.yaml`, automatische Rücknahme bei Verschlechterung. |
| Pipeline-Graph | UI | Ablauf eines Auftrags als inline SVG. |
| Review-Ansicht | UI | Diff (eigener Parser/Renderer) und Freigabe-Knöpfe; schreibende Aktionen über gemeinsamen Schutz (Token, Origin, Host). |
| Wissens-Ansicht | UI | Memory-Einträge und Instinkte aus Phase 3. |
| Metrik-Ansicht, Command-Palette | UI | Darstellung von `computeMetrics`; Palette (⌘K/Strg+K) öffnet Freigaben nur, erteilt sie nie. |
| PWA, lokale Benachrichtigungen | UI | Web App Manifest, Service Worker, Notifications API über WebSocket; kein Web Push. |
| Nachtbetrieb | Daemon, CLI | Aufträge mit `--night` im Nachtfenster mit Token-Budget; Morgenbericht als Inbox-Eintrag. |
| Plane (optional) | Daemon | Nur selbst gehostet, aus ohne Konfiguration; Belege der API in ADR 0011. |

### Definitionen der Metriken (`computeMetrics`)

- Eine Schleife über die nach `id` sortierten Events, Gruppierung nach `traceId` (= Work-Item-ID).
- **Zeitraum:** Zeitbox von 7 Tagen (`periodDays`) ab `periodStart`, lückenlos bis zum Zeitraum, der `now` (oder das letzte Event) enthält. Leeres Log ergibt leere Listen. Events vor `periodStart` zählen in keinem Zeitraum.
- **done/escalated/failed:** Anzahl `workitem.done`, `workitem.escalated`, `workitem.failed` im Zeitraum. **Eskalationsrate** = `escalated / (done + escalated + failed)`, 0 bei keinem Abschluss.
- **Tokens:** Summe `run.finished.data.tokens.input + output` (je Zeitraum und je Rolle/Modell).
- **Fehlversuche je Auftrag:** Implementer-`run.started` im Auftrag minus 1, wenn `acceptance.green` vorkommt, sonst die Anzahl. Nur Aufträge mit mindestens einer Implementer-Session.
- **Erstversuch erfolgreich:** die erste Session einer Rolle im Auftrag endet mit `run.finished.ok` und bis zur nächsten Session derselben Rolle folgt kein `output.invalid` oder `evidence.invalid` dieser Rolle. Für `implementer` zusätzlich kein `review.changes_requested` und kein `gate.failed` vor dem nächsten `acceptance.green`. `review.changes_requested` wird nur dem Implementer angelastet, weil Review-Befunde zur Implementierung zurückführen; sonst würde z. B. jeder Analyst-Erstversuch durch spätere Reviews entwertet. Die Quote gilt für das Modell der ersten Session.
- **Eskalationen je Rolle/Modell:** ein `workitem.escalated` zählt für Rolle und Modell der letzten `run.finished` im Auftrag.
- **Wartezeit:** `approval.requested` bis zum Abschluss mit gleicher `approval_id`, gruppiert nach `kind`; Median und Maximum. Als Abschluss gelten `approval.resolved`, `approval.granted` und `approval.denied`, weil der bestehende Code (`orchestrator.ts`, `integrator.ts`, `onboarding.ts` u. a.) `approval.granted`/`approval.denied` schreibt, der Plan aber `approval.resolved` nennt. Offene Freigaben zählen nicht.

## Standardwerte (aus „Offene Entscheidungen“ des Plans)

1. **Browser-Push:** nur lokale Benachrichtigungen über Service Worker und WebSocket, kein Web Push (Push-Server der Browser-Hersteller wären ein Cloud-Dienst, Regel 3). Bei geschlossenem Browser fangen Morgenbericht und Inbox das auf.
2. **Ausgeschlossene Rollen beim Herabstufen:** analyst, tech-lead, code-reviewer, security-reviewer, architect (Konstante).
3. **Schwellen für Vorschläge:** mindestens 20 Läufe, Erstversuchs-Quote ≥ 0,9, keine Eskalation; Probe über 10 Läufe, Rücknahme unter 0,8.
4. **Ort der Routing-Änderung:** `<home>/routing.override.yaml`; `routing.yaml` im Plugin bleibt unverändert.
5. **Nachtfenster und Budget:** `22:00-06:00`, 2 000 000 Tokens je Nacht, Kennzeichnung je Auftrag mit `--night`.
6. **Zeitraum-Länge für Metriken:** 7 Tage ab Startdatum, konfigurierbar (ADR 0003, offene Frage 1). Das Startdatum ist der erste Montag nach der Installation (Frage 3).
7. **Plane:** nur selbst gehostet, Token aus Umgebungsvariable, aus ohne Konfiguration; Auftragstyp über Label `usac:<typ>`.
8. **UI-Schutz:** Token je Serverstart, Origin- und Host-Prüfung, keine Benutzerkonten. UI bindet nur an `127.0.0.1`.
9. **Diff-Darstellung:** eigener Parser und Renderer, keine Bibliothek.
10. **Palette ohne Freigaben:** die Palette öffnet Freigaben nur, erteilt sie nie. H2 erteilt immer ein Mensch.
11. **Morgenbericht als Inbox-Eintrag:** nicht blockierende Freigabe `night_report`.

## Belege (Regel 2)

**`http://127.0.0.1` ist ein sicherer Kontext, Service Worker sind dort erlaubt.** Quelle: MDN „Secure contexts“, https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts (abgerufen am 2026-11-18):

- „Documents are secure contexts when their resources are delivered over an HTTPS connection, or are delivered from a loopback (local) address.“
- Als „potentially trustworthy“ gelten u. a. Origins mit „A host value of `127.0.0.0/8` or `::1/128`“ und „A host value of `localhost` or `localhost.`“.
- „Only secure contexts are allowed to register service workers, so service workers are always secure contexts.“

Damit kann die UI unter `http://127.0.0.1:<port>` ohne TLS einen Service Worker registrieren. Nicht belegt ist das Verhalten einzelner Browser (siehe offene Frage 1).

## Offene Fragen

1. Service-Worker-Registrierung und Notifications API unter `http://127.0.0.1` in den tatsächlich genutzten Browsern (Chrome, Firefox, Edge; unter WSL2 vom Windows-Browser aus) praktisch prüfen und PWA-Installierbarkeit ohne HTTPS bestätigen.
2. Plane-API (Endpunkte, Authentifizierung, Labels) ist erst mit ADR 0011 belegt; bis dahin bleibt die Anbindung aus.
3. Startdatum „erster Montag nach der Installation“: Woher der Installationszeitpunkt stammt (Config oder erstes Event), wird mit der Metrik-Ansicht festgelegt.
4. Das Event `approval.resolved` existiert im Code bisher nicht; klären, ob es eingeführt oder die Spec auf `approval.granted`/`approval.denied` angepasst wird. `computeMetrics` akzeptiert alle drei.

## Änderung (2026-11-19)

Der Begriff Sprint entfällt. Metriken rechnen mit festen Zeiträumen von 7 Tagen ab Startdatum (`periodStart`, `periodDays`, Feld `periods`, Typ `PeriodMetrics`). Grund: Nutzerwunsch, „ordentlich dokumentieren wie im Entwickler-Alltag“, nicht Scrum.
