---
name: rust
description: Stack-Regeln fuer Rust-Projekte im usac-Team (Testaufbau, Gate-Befehle, verbotene Skip-Marker). Nutzen, wenn ein Projekt das Gate-Profil rust verwendet.
---

# Rust im usac-Team

Gate-Profil: `gate-profiles/rust.yaml`. Belege und offene Fragen: `docs/adr/0007-stack-profile.md`.

## Testaufbau
- Integrationstests unter `tests/<name>.rs`, je Datei ein Testziel (`cargo test --test <name>`).
- Unit-Tests im Quellcode (`#[cfg(test)]`) gelten nicht als Abnahmetest.

## Gate-Befehle (Stufe 1)
- `cargo fmt --check` (optional)
- `cargo clippy -- -D warnings`
- `cargo test`

Abnahmetest: `for t in {stems}; do cargo test --test "$t" || exit 1; done`

## Verbotene Skip-Marker
- `#[ignore]`

Wer einen Test mit diesen Markern ueberspringt, statt ihn gruen zu machen, verstoesst gegen die `skip_markers` des Profils.

## Regeln
- Abnahmetests zuerst: Der Test Engineer schreibt den Test, er muss rot sein, bevor implementiert wird.
- Rot wegen Build- oder Importfehler (Ergebnis `acceptance:build_error`) zaehlt nicht als inhaltlich roter Abnahmetest. Den Test so korrigieren, dass er sich uebersetzt und am Verhalten scheitert.
- Gate-Konfiguration (`protected_globs` des Profils) nie aendern.
- Neue Abhaengigkeiten nur mit ADR in `docs/adr/`.
