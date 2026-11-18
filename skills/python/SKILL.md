---
name: python
description: Stack-Regeln fuer Python-Projekte im usac-Team (Testaufbau, Gate-Befehle, verbotene Skip-Marker). Nutzen, wenn ein Projekt das Gate-Profil python verwendet.
---

# Python im usac-Team

Gate-Profil: `gate-profiles/python.yaml`. Belege und offene Fragen: `docs/adr/0007-stack-profile.md`.

## Testaufbau
- Tests unter `tests/`, Dateien `test_*.py`, Funktionen `test_*` (pytest).
- Quellcode unter `src/<paket>/`; `pythonpath` in `pyproject.toml`.

## Gate-Befehle (Stufe 1)
- `ruff format --check .` (optional)
- `ruff check .`
- `pytest -q`

Abnahmetest: `pytest -q {files}`

## Verbotene Skip-Marker
- `@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`, `xfail`

Wer einen Test mit diesen Markern ueberspringt, statt ihn gruen zu machen, verstoesst gegen die `skip_markers` des Profils.

## Regeln
- Abnahmetests zuerst: Der Test Engineer schreibt den Test, er muss rot sein, bevor implementiert wird.
- Rot wegen Build- oder Importfehler (Ergebnis `acceptance:build_error`) zaehlt nicht als inhaltlich roter Abnahmetest. Den Test so korrigieren, dass er sich uebersetzt und am Verhalten scheitert.
- Gate-Konfiguration (`protected_globs` des Profils) nie aendern.
- Neue Abhaengigkeiten nur mit ADR in `docs/adr/`.
