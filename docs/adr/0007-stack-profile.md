# ADR 0007: Gate-Profile und Stack-Skills für Python, Go, Rust, .NET und Java

Status: **Entwurf** (nur Python mit Werkzeug belegt; Go, Rust, .NET und Java ungeprüft)
Datum: 2026-11-18
Bezug: `docs/superpowers/plans/2026-11-18-phase-3.md` (Task 10), Regel 2 („Kein Raten“) und Regel 3 (keine Zusatzkosten) aus `CLAUDE.md`, ADR 0005 (`network_allow`)

## Kontext

Bisher gibt es Gate-Profile nur für Lua und TypeScript. Phase 3 ergänzt Python, Go, Rust, .NET (nur `dotnet`-CLI) und Java (nur Maven), je mit Skill und Mini-Fixture unter `tests/fixtures/<stack>-mini`. Dafür braucht `acceptance.run` mehr Platzhalter als `{files}`.

## Entscheidung

- Platzhalter in `acceptance.run` (`expandAcceptance` in `packages/daemon/src/gates.ts`): `{files}` (quotierte Pfade), `{dirs}` (eindeutige Elternordner mit `./`, quotiert), `{stems}` (Dateinamen ohne Endung, Leerzeichen), `{stems_csv}` (Komma), `{dotnet_filter}` (`FullyQualifiedName~A|FullyQualifiedName~B`).
- `acceptance.build_error_patterns`: Trifft ein Regex auf die Ausgabe eines roten Abnahmetests, heißt das Ergebnis `acceptance:build_error`. Ein nicht übersetzbarer Test ist kein inhaltlich roter Test.
- Die Muster stehen ohne Backslashes (`error[[]E`), damit die YAML-Anführungszeichen keine Escapes brauchen.
- Befehle, die sich nicht belegen ließen, sind `optional: true` (fehlt das Werkzeug, Exit 127, wird das Gate übersprungen; ein echter Fehlschlag bleibt rot).

## Belege (Regel 2)

Prüfung am 2026-11-18 auf dem Entwicklungsrechner (Windows 11).

| Stack | Werkzeug | Beleg |
|---|---|---|
| Python | ruff 0.17.5, pytest 9.2.0 (in einem temporären venv installiert) | `ruff format --help` zeigt `--check`; `ruff check --help` vorhanden; `pytest --help` zeigt `-q, --quiet`. Fixture `python-mini`: `ruff check .`, `ruff format --check .` und `pytest -q` laufen grün. |
| Go | nicht installiert | **ungeprüft**: `gofmt -l .`, `go vet ./...`, `go test ./...`, `go test <dirs>` |
| Rust | nicht installiert | **ungeprüft**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `cargo test --test <name>` |
| .NET | nur Runtime, kein SDK (`dotnet --list-sdks` leer) | **ungeprüft**: `dotnet format --verify-no-changes`, `dotnet build -warnaserror`, `dotnet test`, `dotnet test --filter "..."` |
| Java | `java` und `mvn` nicht installiert | **ungeprüft**: `mvn -q spotless:check`, `mvn -q verify -DskipTests`, `mvn -q test`, `mvn -q test -Dtest=...` |

Die Fixtures für Go, Rust, .NET und Java sind ungeprüft: Sie wurden nie gebaut. Die Werkzeugläufe in `tests/acceptance/stacks.test.ts` (`USAC_TOOLCHAIN_TESTS=1`) holen das nach, sobald das Werkzeug vorhanden ist.

## Offene Fragen

1. Go, Rust, .NET, Java: Alle Befehle gegen `--help` bzw. Doku der installierten Version prüfen; Fixtures bauen und Stufe 1 laufen lassen.
2. `mvn spotless:check` setzt das Spotless-Plugin in der `pom.xml` voraus; die Fixture enthält es nicht (Gate ist optional, Exit ≠ 127 würde aber rot werden). Klären, ob das Gate nur bei vorhandenem Plugin laufen soll.
3. `dotnet format` und `dotnet build -warnaserror`: Verhalten ohne `.editorconfig` und mit Test-SDK-Warnungen prüfen.
4. `cargo test --test <stem>` setzt voraus, dass der Abnahmetest unter `tests/<stem>.rs` liegt.
5. `network_allow`-Hosts (Go-Proxy, crates.io, NuGet, Maven Central, PyPI) sind aus dem Gedächtnis der jeweiligen Standardkonfiguration, nicht gemessen; echte Sandbox-Läufe unter WSL2 stehen aus (siehe ADR 0005).
6. `build_error_patterns` sind je Stack Annahmen über die Ausgabeformate; für Go, Rust, .NET, Java ungeprüft.

## Folgen

Neue Stacks brauchen nur ein Profil, einen Skill und eine Fixture. Der Orchestrator bleibt deterministisch; er liest nur Profil-Felder.
