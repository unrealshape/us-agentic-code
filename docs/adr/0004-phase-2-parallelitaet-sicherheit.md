# ADR 0004: Phase 2 – Parallelität und Sicherheit

Status: **Entwurf**
Datum: 2026-11-18
Bezug: `docs/roadmap.md` (Phase 2), `docs/adr/0002-phase-1-entwurf.md` („Nicht in Phase 1“), `docs/adr/0003-scrum-ablauf.md` (WIP-Limit), Regeln 5 und 6 aus `CLAUDE.md`

## Kontext

Phase 1 führt immer nur einen Run aus. Phase 2 soll bis zu drei Runs parallel laufen lassen, ohne dass zwei Runs dieselbe Datei ändern, und die Sessions härter absichern. Nach Regel 6 braucht jeder neue Baustein eine Begründung; dieses ADR fasst die Bausteine der Phase 2 zusammen (das Sandbox-Netzwerk steht in ADR 0005). Nach Regel 5 entscheidet über Reihenfolge, Vergabe und Prüfer ausschließlich Code.

## Bausteine

### Queue und Slots

- Aufträge mit Status `queued` werden FIFO nach `createdAt` gestartet, noch ohne Priorität.
- Ein Slot ist eine Zeile in der Tabelle `slots` der vorhandenen SQLite-Datei (`~/.usac/usac.db`). Höchstens `MAX_PARALLEL = 3` Slots gleichzeitig.
- Vergabe in einer `BEGIN IMMEDIATE`-Transaktion, damit mehrere Prozesse (CLI und Daemon) dieselbe Grenze sehen.
- Nur `running` belegt einen Slot. Ein Auftrag in `awaiting_approval` gibt seinen Slot frei.
- Stirbt ein Prozess, verfällt der Slot nach dem Timeout; der Auftrag geht von `running` zurück auf `queued` (Event `slot.expired`).
- Begründung: kein zusätzlicher Dienst, keine Sperrdateien; SQLite ist schon da und bietet atomare Transaktionen über Prozesse hinweg.

### Datei-Leases mit Heartbeat

- Umsetzung: `packages/daemon/src/leases.ts`, Tabelle `leases(project, path, work_item_id, acquired_at, heartbeat_at)`, Primärschlüssel `(project, path)`.
- Vergabe alles oder nichts in `BEGIN IMMEDIATE`. Der eigene Halter darf einen Pfad erneut nehmen (frischt den Heartbeat auf).
- Pfade werden vor dem Vergleich normalisiert: `\` → `/`, führendes `./` weg, doppelte `/` zusammen. `src\a.lua`, `./src/a.lua` und `src/a.lua` sind ein und derselbe Lease.
- Der projektweite Lease `*` kollidiert mit jedem Pfad desselben Projekts, in beide Richtungen. Andere Projekte sind unberührt.
- Freigabe durch `expireLeases`: sofort, wenn der Auftrag `done`, `failed` oder `escalated` ist; bei `running` oder `queued`, wenn der letzte Heartbeat älter als der Timeout ist.
- Ein Auftrag in `awaiting_approval` verliert seine Leases nie, auch nicht nach Tagen. Sonst könnte ein zweiter Run dieselbe Datei ändern, während der erste auf H2 wartet, und der PR kollidiert.
- Bugfix hat keinen Plan und nimmt daher den projektweiten Lease `*`.
- Begründung: Worktrees isolieren das Arbeitsverzeichnis, aber nicht die Integration; Leases verhindern Merge-Konflikte vor der Arbeit statt danach.

### GateGuard

- Eigener `PreToolUse`-Hook (`hooks/scripts/gateguard.ts`) für `Write|Edit|MultiEdit|NotebookEdit`, nach dem Protector-Eintrag.
- Vor der ersten Änderung einer Datei verlangt er Fakten (Meldung beginnt mit `GateGuard: Bevor du <pfad> änderst, nenne diese Fakten:`). Der zweite Versuch je Datei wird ohne Inhaltsprüfung erlaubt.
- Nur für `implementer` und `build-fixer`, nie für Bash. Eigene Fehler fail-open (Exit 0).
- Idee aus ECC (`third_party/ecc/skills/gateguard`), eigene deutsche Umsetzung ohne Fremdcode; Herkunft in `THIRD_PARTY.md`.

### Protector-Modi

- Modi `lernen`, `melden`, `blockieren`, eingestellt in `.usac/project.yaml` (`protector.mode`).
- Standard ist `blockieren`. Unbekannte oder leere Werte (auch Tippfehler wie `blockiern`) gelten als `blockieren`, nie als `lernen`.
- `melden` erzeugt nicht blockierende Inbox-Einträge der Art `protector`.
- Hooks schreiben ihre Entscheidungen als JSONL je Session; der Orchestrator liest sie nach dem Lauf als Events ein.

### Doppel-Review

- Der Review-Handler arbeitet mit „Sitzen“; Anzahl und Rollen bestimmt Code aus Größe und Security-Triggern.
- Größe `large`: zwei unabhängige `code-reviewer`-Sitze auf Opus.
- Security-Trigger: Zweitprüfer ist `security-reviewer` auf Opus (vom Kontingent-Deckel ausgenommen).
- Höchstens zwei Sitze; bei `large` und Trigger gleichzeitig Code- plus Security-Review.
- Befunde aller Sitze werden gesammelt; entschieden wird erst nach allen Sitzen.

## Entscheidung: kein Fable im Doppel-Review

Fable ist laut `routing.yaml` (`fable.only_roles: [architect]`) und Roadmap (Entscheidung 2026-11-18) nur für die Rolle `architect` erlaubt. Das Doppel-Review nutzt daher **nie** Fable. Liefert `resolveModel` für einen Review-Sitz `fable`, bricht der Review-Handler hart ab (`Fable im Review ist nicht erlaubt (ADR 0004)`).

## Standardwerte

| Wert | Standard |
|---|---|
| `MAX_PARALLEL` (Slots) | 3 |
| `LEASE_TIMEOUT_MS` (Lease- und Slot-Timeout) | 120 000 ms (120 s) |
| `HEARTBEAT_MS` | 30 000 ms (30 s) |
| Takt des Daemons | 1 s |
| `PROJECT_WIDE` | `*` |
| Protector-Modus | `blockieren` |
| GateGuard | aktiv (`gateguard.enabled: true`) |
| Netzwerk-Allowlist | leer (`network.allow: []`, `network_allow: []`), siehe ADR 0005 |
| Review-Sitze | höchstens 2 |
| Queue-Reihenfolge | FIFO nach `createdAt` |

## Folgen und Kosten

- Bugfixes im selben Projekt laufen nie parallel (projektweiter Lease).
- Eine vergessene H2 blockiert Dateien beliebig lange; sichtbar über die Inbox.
- Ein Absturz blockiert Slot und Leases bis zu 2 min; kürzere Timeouts würden bei hängender Platte Leases zu früh freigeben.
- Mehr als drei Aufträge können gleichzeitig „in Arbeit“ sein, weil wartende keinen Slot belegen; das WIP-Limit aus ADR 0003 zählt nur aktive Sessions.
- Die Backlog-Priorität aus ADR 0003 braucht später eine Spalte und eine Migration.
- Große sicherheitsrelevante Änderungen haben ein unabhängiges Code-Review weniger (zwei Sitze statt drei).
- Ein Modell kann die GateGuard-Fragen ignorieren; eine Prüfung des Transkripts auf Grep/Read-Aufrufe wäre ein Folgetask.
- Viele `melden`-Einträge füllen die Inbox; Bündelung je Run wäre nötig.

## Offene Fragen

- Erben Hooks die Umgebung des `claude`-Prozesses (Protector-Modus, Pfad des Hook-Logs)? Bestätigung in echter Session unter WSL2, Ergebnis in ADR 0005.
