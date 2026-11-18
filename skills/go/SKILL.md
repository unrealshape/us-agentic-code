---
name: go
description: Stack-Regeln fuer Go-Projekte im usac-Team (Testaufbau, Gate-Befehle, verbotene Skip-Marker). Nutzen, wenn ein Projekt das Gate-Profil go verwendet.
---

# Go im usac-Team

Gate-Profil: `gate-profiles/go.yaml`. Belege und offene Fragen: `docs/adr/0007-stack-profile.md`.

## Testaufbau
- Tests neben dem Quellcode, Dateien `*_test.go`, Funktionen `TestXxx(t *testing.T)`.
- Ein Paket je Ordner; der Abnahmetest laeuft je Ordner (`{dirs}`).

## Gate-Befehle (Stufe 1)
- `test -z "$(gofmt -l .)"` (optional)
- `go vet ./...`
- `go test ./...`

Abnahmetest: `go test {dirs}`

## Verbotene Skip-Marker
- `t.Skip(`

Wer einen Test mit diesen Markern ueberspringt, statt ihn gruen zu machen, verstoesst gegen die `skip_markers` des Profils.

## Regeln
- Abnahmetests zuerst: Der Test Engineer schreibt den Test, er muss rot sein, bevor implementiert wird.
- Rot wegen Build- oder Importfehler (Ergebnis `acceptance:build_error`) zaehlt nicht als inhaltlich roter Abnahmetest. Den Test so korrigieren, dass er sich uebersetzt und am Verhalten scheitert.
- Gate-Konfiguration (`protected_globs` des Profils) nie aendern.
- Neue Abhaengigkeiten nur mit ADR in `docs/adr/`.
