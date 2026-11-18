// Command-Palette (Phase 5, ADR 0010): Befehlsliste fuer `public/palette.js`.
// Die Palette oeffnet nur Seiten. Freigaben werden hier nie erteilt, nur ihre Review-Seite geoeffnet.
import { join } from "node:path";
import type { Hono } from "hono";
import type { Store } from "../../../daemon/src/store";

export type PaletteCommand = { id: string; label: string; href?: string; action?: "approve" | "deny"; approvalId?: number };

const RECENT_RUNS = 20;

/** Befehle fuer die Palette: feste Seiten, die neuesten Runs, offene Freigaben (nur als Link auf Review) und Memory-Suche. */
export function commandsData(store: Store): PaletteCommand[] {
  const cmds: PaletteCommand[] = [
    { id: "page-inbox", label: "Inbox", href: "/" },
    { id: "page-wall", label: "Agent-Wand", href: "/wall" },
    { id: "page-metrics", label: "Metriken", href: "/metrics" },
    { id: "page-knowledge", label: "Wissen", href: "/knowledge" },
    // Die Palette haengt den Suchbegriff an diesen Link an.
    { id: "memory-search", label: "Memory durchsuchen", href: "/knowledge?q=" },
  ];
  for (const wi of store.listWorkItems().slice(0, RECENT_RUNS)) {
    const enc = encodeURIComponent(wi.id);
    cmds.push({ id: `run-${wi.id}`, label: `Run ${wi.id}: ${wi.title}`, href: `/runs/${enc}` });
    cmds.push({ id: `pipeline-${wi.id}`, label: `Pipeline ${wi.id}`, href: `/runs/${enc}/pipeline` });
    cmds.push({ id: `review-${wi.id}`, label: `Review ${wi.id}`, href: `/runs/${enc}/review` });
  }
  for (const a of store.pendingApprovals()) {
    cmds.push({
      id: `approval-${a.id}`,
      label: `Freigabe ${a.kind} ${a.id} öffnen`,
      href: `/runs/${encodeURIComponent(a.workItemId)}/review`,
      approvalId: a.id,
    });
  }
  return cmds;
}

/** Registriert `GET /api/palette` (Befehle als JSON) und `GET /palette.js` (das Skript aus `public/`). */
export function registerPalette(app: Hono, store: Store): void {
  app.get("/api/palette", (c) => c.json(commandsData(store)));
  app.get("/palette.js", () => {
    const file = Bun.file(join(import.meta.dir, "../../public/palette.js"));
    return new Response(file, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  });
}
