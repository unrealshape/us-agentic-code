/** Gemeinsamer Seitenrahmen der UI. Die Views aus UI v1 stellt erst Task 10 darauf um. */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escaped Text fuer HTML-Inhalt und Attributwerte (in doppelten Anfuehrungszeichen). */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const NAV: [string, string][] = [
  ["/", "Inbox"],
  ["/wall", "Agent-Wand"],
  ["/metrics", "Metriken"],
  ["/knowledge", "Wissen"],
];

/**
 * Vollstaendige Seite: Navigation, Manifest, `palette.js` und optional das Token fuer
 * schreibende Aktionen als `<meta name="usac-token">`. `body` muss bereits escaped sein.
 */
export function page(title: string, body: string, opts: { token?: string } = {}): string {
  const token = opts.token !== undefined ? `<meta name="usac-token" content="${esc(opts.token)}">` : "";
  const nav = NAV.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join(" | ");
  return (
    `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<link rel="manifest" href="/manifest.webmanifest">${token}` +
    `<script src="/palette.js" defer></script>` +
    `</head><body><nav aria-label="Hauptnavigation">${nav}</nav><main>${body}</main></body></html>`
  );
}
