---
name: java
description: Stack-Regeln fuer Java-Projekte im usac-Team (Testaufbau, Gate-Befehle, verbotene Skip-Marker). Nutzen, wenn ein Projekt das Gate-Profil java verwendet.
---

# Java im usac-Team

Gate-Profil: `gate-profiles/java.yaml`. Belege und offene Fragen: `docs/adr/0007-stack-profile.md`.

## Testaufbau
- Maven-Standardlayout: Tests unter `src/test/java/`, Klassen `*Test` (JUnit 5).
- Nur Maven, kein Gradle.
- Der Abnahmetest waehlt Klassen nach Dateiname (`-Dtest={stems_csv}`).

## Gate-Befehle (Stufe 1)
- `mvn -q spotless:check` (optional)
- `mvn -q verify -DskipTests`
- `mvn -q test`

Abnahmetest: `mvn -q test -Dtest={stems_csv}`

## Verbotene Skip-Marker
- `@Disabled`, `@Ignore`

Wer einen Test mit diesen Markern ueberspringt, statt ihn gruen zu machen, verstoesst gegen die `skip_markers` des Profils.

## Regeln
- Abnahmetests zuerst: Der Test Engineer schreibt den Test, er muss rot sein, bevor implementiert wird.
- Rot wegen Build- oder Importfehler (Ergebnis `acceptance:build_error`) zaehlt nicht als inhaltlich roter Abnahmetest. Den Test so korrigieren, dass er sich uebersetzt und am Verhalten scheitert.
- Gate-Konfiguration (`protected_globs` des Profils) nie aendern.
- Neue Abhaengigkeiten nur mit ADR in `docs/adr/`.
