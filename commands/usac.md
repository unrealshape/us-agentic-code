---
description: US-AGENTIC-CODE steuern (init, run, status, approve, doctor)
argument-hint: "<init|run|resume|status|events|approve|doctor> [optionen]"
allowed-tools: Bash(bun:*)
---

Fuehre die US-AGENTIC-CODE-CLI mit den uebergebenen Argumenten aus und gib die Ausgabe unveraendert wieder:

!`bun ${CLAUDE_PLUGIN_ROOT}/packages/daemon/src/cli.ts $ARGUMENTS`

Wenn ein Auftrag auf eine Freigabe wartet, nenne die Freigabe-ID und den Befehl zum Freigeben. Erfinde keine Status, die nicht in der Ausgabe stehen.
