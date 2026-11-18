# ADR 0009: Werkzeuge der Gate-Stufen 3 bis 6

Status: **Entwurf** (Befehle für Semgrep, gitleaks, Trivy und Playwright ungeprüft)
Datum: 2026-11-18
Bezug: ADR 0008 (Standardwerte, Pflichtwerkzeuge), `docs/superpowers/plans/2026-11-18-phase-4.md` (Task 6), Regel 2 aus `CLAUDE.md`

## Kontext

Phase 4 führt die Gate-Stufen 3 (E2E), 4 (Sicherheit), 5 (Coverage-Diff) und 6 (Nachweis je Kriterium) ein. Stufen 3 und 4 rufen externe Werkzeuge auf, Stufen 5 und 6 sind interne Gates. Regel 2 verlangt für jeden Werkzeugbefehl einen Beleg (Hilfe-Ausgabe, Doku, Test).

## Entscheidung

- `GateStage` bekommt `internal` (`coverage_diff` | `criteria_evidence`; dann ist `run` entbehrlich) und `required_in` (Work-Item-Typen, Standard `[]`).
- Fehlt ein Werkzeug (Exit 127), ist das Gate `failed`, wenn der Typ des Work-Items in `required_in` steht, sonst wie bisher `skipped` bei `optional: true`. Dieselbe Regel gilt für fehlende Eingaben interner Gates (lcov-Datei, Kriterien).
- `GateProfile` bekommt `includes` (lädt `gate-profiles/_shared/<name>.yaml` und hängt deren `stages` an) und optional `coverage` (`lcov`, `include`, `threshold`).
- `runStages` ersetzt `{base}` durch den Basis-Commit, reicht `ctx.env` (z. B. `BASE_URL` der Preview, `DATABASE_URL`) an den Befehl durch, führt nur Stufen `minStage..maxStage` aus und sortiert stabil nach Stufe.
- `gate-profiles/_shared/security.yaml` (Stufe 4): `semgrep`, `gitleaks`, `trivy`, alle `optional: true`, `required_in: [security-fix, dependency-update]`.
- `gate-profiles/typescript.yaml`: `includes: [security]`, Stufe 3 `e2e` (Playwright, optional), Stufe 5 `coverage` (lcov mit Bun) und `coverage_diff` (Schwelle 0,8).

## Belege (Regel 2)

Prüfung am 2026-11-18 auf dem Entwicklungsrechner (Windows 11, Git Bash).

| Werkzeug | Stand | Beleg |
|---|---|---|
| Semgrep | nicht installiert (`command -v semgrep` leer) | **ungeprüft**: `semgrep scan --config p/default --error --metrics=off` (Befehl laut Plan) |
| gitleaks | nicht installiert (`command -v gitleaks` leer) | **ungeprüft**: `gitleaks git --log-opts="{base}..HEAD" --redact --exit-code 1 .` |
| Trivy | nicht installiert (`command -v trivy` leer) | **ungeprüft**: `trivy fs --scanners vuln --severity HIGH,CRITICAL --exit-code 1 .` (Befehl laut Plan) |
| Playwright | nicht installiert; `npx` 11.20.0 vorhanden | **ungeprüft**: `npx --no-install playwright test`. Belegt ist nur: `npx --no-install playwright test --help` ohne installiertes Paket endet mit `npx canceled due to missing packages and no YES option: ["playwright@1.65.1"]` und Exit 1 (nicht 127). Deshalb prüft das Gate vorher `node_modules/.bin/playwright` und meldet sonst Exit 127. |
| Bun (lcov) | Bun 1.4.4 | `bun test --help` zeigt `--coverage`, `--coverage-reporter=<val>` („'text' and/or 'lcov'“) und `--coverage-dir=<val>` (Standard `coverage`). Probelauf in einem temporären Ordner: `bun test --coverage --coverage-reporter=lcov` schreibt `coverage/lcov.info` mit `SF:a.ts` und `DA:1,1`. |
| Interne Gates | – | `tests/acceptance/gate-stages.test.ts` (coverage_diff unter/über Schwelle, criteria_evidence ohne Marke) |

## Offene Fragen

1. Semgrep: `semgrep scan --help` der installierten Version prüfen (`--config p/default`, `--error`, `--metrics=off`). `p/default` lädt Regeln aus der Semgrep-Registry; das braucht Netzzugang und widerspricht ggf. der Sandbox (`network_allow`). Klären, ob Regeln lokal vorgehalten werden müssen.
2. gitleaks: `gitleaks --help` prüfen. Der Unterbefehl `git` gibt es erst ab neueren 8er-Versionen; ältere nutzen `gitleaks detect --log-opts=...`. Ebenso `--redact` und `--exit-code` belegen.
3. Trivy: `trivy fs --help` prüfen (`--scanners vuln`, `--severity`, `--exit-code`). Trivy lädt seine Schwachstellen-Datenbank aus dem Netz; Verhalten ohne Netz und in der Sandbox klären.
4. Playwright: `npx playwright test --help` mit installiertem Paket prüfen und Version notieren; Browser-Installation (`npx playwright install`) ist nicht Teil des Gates (ADR 0008, Punkt 14).
5. `coverage.include` im TypeScript-Profil (`src/**`, `packages/**/src/**`, `lib/**`, `app/**`) ist eine Annahme über übliche Projektlayouts; je Projekt anpassbar machen, falls nötig.
6. Die übrigen Stack-Profile (Lua, Python, Go, Rust, .NET, Java) bekommen Stufe 3 bis 5 erst, wenn Werkzeug und lcov-Ausgabe belegt sind (ADR 0008, Coverage-Format).

## Folgen

Fehlende Sicherheitswerkzeuge sind in `feature` nur als `skipped` sichtbar, in `security-fix` und `dependency-update` dagegen ein rotes Gate. Bis die offenen Fragen geklärt sind, kann ein installiertes Werkzeug mit abweichender Befehlssyntax rot werden (Exit ≠ 127); das ist gewollt sichtbar statt still übersprungen.
