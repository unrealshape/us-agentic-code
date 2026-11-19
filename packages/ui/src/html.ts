/** Gemeinsamer Seitenrahmen der UI. Die Views aus UI v1 stellt erst Task 10 darauf um. */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escaped Text fuer HTML-Inhalt und Attributwerte (in doppelten Anfuehrungszeichen). */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}


/** Gestaltung "Kontrollraum": dunkel, Statuslichter, Zahlen in Tabellenziffern. Keine externen Dateien. */
const STYLE = `
:root{--bg:#0b0e13;--panel:#131821;--panel2:#18202c;--line:#222b39;--text:#d7dde7;--muted:#7d8796;--ok:#3ddc84;--run:#4aa3ff;--warn:#ffb020;--err:#ff5c5c;--radius:8px;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
header.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:28px;padding:10px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
header.top .brand{font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:12px}
header.top nav{display:flex;gap:2px;flex-wrap:wrap}
header.top nav a{color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:6px;font-size:13px}
.notify{margin-left:auto;font:inherit;font-size:12px;background:var(--panel2);color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
header.top nav a:hover{color:var(--text);background:var(--panel2)}
header.top nav a[aria-current="page"]{color:var(--text);background:var(--panel2);box-shadow:inset 0 -2px 0 var(--run)}
main{max-width:1280px;margin:0 auto;padding:20px 20px 64px}
h1{font-size:12px;margin:0 0 14px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h2{font-size:12px;margin:0 0 8px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
a{color:var(--run)}
.muted{color:var(--muted)}
.empty{color:var(--muted);padding:24px;border:1px dashed var(--line);border-radius:var(--radius);text-align:center}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.col{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px;min-height:120px}
.col h2{display:flex;justify-content:space-between}
.tile{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:8px}
.tile .id{font:12px ui-monospace,Consolas,monospace;color:var(--muted)}
.tile .t{font-weight:600;margin:2px 0 6px}
.light{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:6px;vertical-align:middle}
.light.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.light.run{background:var(--run);box-shadow:0 0 8px var(--run)}
.light.warn{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.light.err{background:var(--err);box-shadow:0 0 8px var(--err)}
.bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--run)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700}
code{font:12px ui-monospace,Consolas,monospace;color:var(--muted)}
.badge{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.badge.warn{color:var(--warn)}
.badge.ok{color:var(--ok)}
.badge.err{color:var(--err)}
.badge.info{color:var(--run)}
button.act{font:inherit;font-size:12px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button.act:disabled{color:var(--muted);cursor:default}
.appr .btns{margin-left:4px}
.appr .rowmsg{display:block;color:var(--err);font-size:12px;margin-top:4px}
.pick{display:block;width:100%;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer}
.pick .id{display:block;font:12px ui-monospace,Consolas,monospace;color:var(--muted)}
.pick .t{display:block;font-weight:600;margin:2px 0 6px}
.tile.sel{border-color:var(--run)}
.detail{margin-top:14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}
a:focus-visible,button:focus-visible{outline:2px solid var(--run);outline-offset:2px}
ol.events{list-style:none;padding:0;margin:0;font:13px ui-monospace,Consolas,monospace}
ol.events li{padding:6px 0;border-bottom:1px solid var(--line);color:var(--text)}
ol.events li:last-child{border-bottom:0}
input,select,textarea{font:inherit;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--run);outline-offset:2px}
@media (max-width:640px){header.top{flex-direction:column;align-items:flex-start;gap:8px;padding:10px 12px}main{padding:14px 12px 48px}}
`;

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
  const nav = NAV.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join("");
  return (
    `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<meta name="color-scheme" content="dark">${token}<style>${STYLE}</style>` +
    `<link rel="manifest" href="/manifest.webmanifest">` +
    `<script src="/palette.js" defer></script><script type="module" src="/notify.js"></script>` +
    `</head><body><header class="top"><span class="brand">usac</span><nav aria-label="Hauptnavigation">${nav}</nav><button id="notify-enable" type="button" class="notify">Benachrichtigungen</button></header><main>${body}</main></body></html>`
  );
}
