# Fremdcode und Ideen

## ECC (affaan-m/ecc), MIT

Quelle: https://github.com/affaan-m/ecc, Commit `3f14a103a8694e51c1df9a806217a6d0b5f7a6f7` (2026-11-17).
Lizenz: `third_party/ecc/LICENSE` (Copyright (c) 2026 Affaan Mustafa).

Unveraendert kopiert nach `third_party/ecc/`:

- `agents/`: code-reviewer, security-reviewer, tdd-guide, planner, architect, code-architect, silent-failure-hunter, e2e-runner, build-error-resolver, doc-updater, code-explorer, spec-miner, pr-test-analyzer, loop-operator
- `skills/`: delivery-gate, gateguard, santa-method, orch-pipeline, continuous-learning-v2, verification-loop, search-first, codebase-onboarding

Uebernommene Ideen (eigene Umsetzung): Groessenklassen und Security-Trigger (orch-pipeline), Delivery-Gate, Eskalationskriterien (loop-operator), Rollenzuschnitt der Agents.

## Ruflo (ruvnet/ruflo), MIT

Quelle: https://github.com/ruvnet/ruflo. Kein Code uebernommen, nur Ideen in eigener Umsetzung:

- Protector mit eng gefassten Blockregeln und fail-open (plugins/ruflo-protector)
- Regel-Compiler aus CLAUDE.md (@claude-flow/guidance), geplant fuer Phase 3
- Leases mit Heartbeat (@claude-flow/claims), geplant fuer Phase 2

## Graphify (Graphify-Labs/graphify), MIT

Externe Abhaengigkeit (`pip install graphifyy`), wird nur aufgerufen, nicht kopiert.
