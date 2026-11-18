---
name: dotnet
description: Stack-Regeln fuer .NET-Projekte im usac-Team (Testaufbau, Gate-Befehle, verbotene Skip-Marker). Nutzen, wenn ein Projekt das Gate-Profil dotnet verwendet.
---

# .NET im usac-Team

Gate-Profil: `gate-profiles/dotnet.yaml`. Belege und offene Fragen: `docs/adr/0007-stack-profile.md`.

## Testaufbau
- Testprojekt unter `tests/` (xUnit), Klassen `*Tests`, Methoden mit `[Fact]`.
- Nur die `dotnet`-CLI, kein MSBuild oder Visual Studio.
- Der Abnahmetest filtert nach Klassenname aus dem Dateinamen (`{dotnet_filter}`).

## Gate-Befehle (Stufe 1)
- `dotnet format --verify-no-changes` (optional)
- `dotnet build -warnaserror`
- `dotnet test`

Abnahmetest: `dotnet test --filter "{dotnet_filter}"`

## Verbotene Skip-Marker
- `Skip =`, `[Ignore`

Wer einen Test mit diesen Markern ueberspringt, statt ihn gruen zu machen, verstoesst gegen die `skip_markers` des Profils.

## Regeln
- Abnahmetests zuerst: Der Test Engineer schreibt den Test, er muss rot sein, bevor implementiert wird.
- Rot wegen Build- oder Importfehler (Ergebnis `acceptance:build_error`) zaehlt nicht als inhaltlich roter Abnahmetest. Den Test so korrigieren, dass er sich uebersetzt und am Verhalten scheitert.
- Gate-Konfiguration (`protected_globs` des Profils) nie aendern.
- Neue Abhaengigkeiten nur mit ADR in `docs/adr/`.
