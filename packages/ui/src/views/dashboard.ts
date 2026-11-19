import type { Store } from "../../../daemon/src/store";
import { esc } from "../html";

/** Daten fuer das Dashboard: Stories, Schritte (gefiltert auf eine Story, wenn angegeben), Tabellenzaehler, letzte Events. */
export function dashboardData(store: Store, storyId?: string) {
  const stories = store.listWorkItems().map((w) => ({
    id: w.id,
    title: w.title,
    type: w.type,
    status: w.status,
    size: w.size,
    createdAt: w.createdAt,
  }));
  const steps = store.listSteps(storyId);
  return {
    stories,
    story: storyId ?? null,
    steps,
    tables: store.tableCounts(),
    events: store.recentEvents(30).map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, traceId: e.traceId })),
    now: new Date().toISOString(),
  };
}

const NAV: [string, string][] = [
  ["/", "Inbox"],
  ["/wall", "Agent-Wand"],
  ["/metrics", "Metriken"],
  ["/knowledge", "Wissen"],
];

const CSS = `
:root{--bg:#0b0e13;--panel:#131821;--panel2:#18202c;--line:#222b39;--text:#d7dde7;--muted:#7d8796;--ok:#3ddc84;--run:#4aa3ff;--warn:#ffb020;--err:#ff5c5c;--radius:8px;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;display:grid;grid-template-columns:240px 1fr;min-height:100vh}
aside{background:var(--panel);border-right:1px solid var(--line);padding:18px 14px;position:sticky;top:0;height:100vh;overflow:auto}
aside .brand{font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:12px;margin-bottom:18px}
aside h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}
aside a{display:flex;justify-content:space-between;align-items:center;color:var(--text);text-decoration:none;padding:7px 10px;border-radius:6px;font-size:13px}
aside a:hover{background:var(--panel2)}
aside a.sel{background:var(--panel2);box-shadow:inset 3px 0 0 var(--run)}
aside a .sub{display:block;color:var(--muted);font-size:11px}
.count{color:var(--muted);font-size:12px}
main{padding:20px 24px 64px;min-width:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
.pill{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:6px 12px;border-radius:999px;background:var(--panel);border:1px solid var(--line)}
.pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);margin-right:6px}
.pill.off .dot{background:var(--err);box-shadow:0 0 8px var(--err)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}
.tile .lbl{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.tile .val{font-size:22px;font-weight:700;margin-top:4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin-bottom:14px}
.card h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.step{display:grid;grid-template-columns:18px 1fr auto;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.light{width:9px;height:9px;border-radius:50%;background:var(--muted);margin-top:6px}
.light.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.light.err{background:var(--err);box-shadow:0 0 8px var(--err)}
.step .role{font-weight:600}
.step .meta{color:var(--muted);font-size:12px}
.step .files{margin-top:4px;font:12px ui-monospace,Consolas,monospace;color:var(--text)}
.step .reason{color:var(--err);font-size:12px;margin-top:4px}
table{width:100%;border-collapse:collapse;font:13px ui-monospace,Consolas,monospace}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-family:inherit}
tr.new td{animation:flash 2.4s ease-out}
@keyframes flash{from{background:rgba(74,163,255,.28)}to{background:transparent}}
.empty{color:var(--muted);padding:18px;border:1px dashed var(--line);border-radius:var(--radius);text-align:center}
@media (max-width:760px){body{grid-template-columns:1fr}aside{position:static;height:auto}}
`;

/** Client-Teil: rendert aus /api/dashboard neu, markiert neue Events, zeigt Live-Status. */
const SCRIPT = `
(function(){
  var story = new URLSearchParams(location.search).get("story");
  var seen = null, lastOk = Date.now(), data = JSON.parse(document.getElementById("initial").textContent);
  function el(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text !== undefined) n.textContent = text; return n; }
  function render(d){
    var steps = document.getElementById("steps"); steps.textContent = "";
    if(!d.steps.length){ steps.appendChild(el("div","empty","Noch keine Schritte für diese Auswahl.")); }
    d.steps.forEach(function(s){
      var row = el("div","step");
      row.appendChild(el("span","light "+(s.ok?"ok":"err")));
      var mid = el("div");
      mid.appendChild(el("div","role", s.role));
      mid.appendChild(el("div","meta", s.model + " · " + s.startedAt.slice(11,19) + "–" + s.endedAt.slice(11,19)));
      if(s.files.length) mid.appendChild(el("div","files", s.files.join("  ·  ")));
      if(s.reason) mid.appendChild(el("div","reason", s.reason));
      row.appendChild(mid);
      row.appendChild(el("span","count", s.ok ? "ok" : "fehlgeschlagen"));
      steps.appendChild(row);
    });
    var ok = d.steps.filter(function(s){return s.ok;}).length;
    document.getElementById("t-steps").textContent = d.steps.length;
    document.getElementById("t-ok").textContent = ok;
    document.getElementById("t-files").textContent = new Set([].concat.apply([], d.steps.map(function(s){return s.files;}))).size;
    var tbody = document.getElementById("events"); tbody.textContent = "";
    d.events.slice().reverse().forEach(function(e){
      var tr = el("tr", seen !== null && e.id > seen ? "new" : "");
      tr.appendChild(el("td", null, String(e.id)));
      tr.appendChild(el("td", null, e.ts.slice(11,19)));
      tr.appendChild(el("td", null, e.type));
      tr.appendChild(el("td", null, e.actor));
      tbody.appendChild(tr);
    });
    var max = d.events.reduce(function(m,e){return Math.max(m,e.id);}, 0);
    if(seen === null || max > seen) seen = max;
  }
  function status(){
    var pill = document.getElementById("pill");
    var sec = Math.round((Date.now() - lastOk)/1000);
    pill.className = "pill" + (sec > 10 ? " off" : "");
    pill.lastChild.textContent = sec > 10 ? " OFFLINE" : " CONNECTED · vor " + sec + " s";
  }
  function poll(){
    fetch("/api/dashboard" + (story ? "?story=" + encodeURIComponent(story) : ""), {headers:{accept:"application/json"}})
      .then(function(r){ return r.json(); })
      .then(function(d){ data = d; lastOk = Date.now(); render(d); })
      .catch(function(){});
  }
  render(data);
  status();
  setInterval(poll, 2000);
  setInterval(status, 1000);
})();
`;

export function dashboardHtml(store: Store, storyId?: string): string {
  const d = dashboardData(store, storyId);
  const selected = storyId ? d.stories.find((s) => s.id === storyId) : undefined;
  const storyLinks = d.stories
    .map((s) => `<a href="/dashboard?story=${encodeURIComponent(s.id)}" class="${s.id === storyId ? "sel" : ""}"><span>${esc(s.title)}<span class="sub">${esc(s.type)} · ${esc(s.status)}</span></span></a>`)
    .join("") || `<p class="count">Noch keine Stories.</p>`;
  const tableLinks = Object.entries(d.tables)
    .map(([t, n]) => `<a href="#"><span>${esc(t)}</span><span class="count">${n}</span></a>`)
    .join("");
  const nav = NAV.map(([href, label]) => `<a href="${href}"><span>${esc(label)}</span></a>`).join("");
  const initial = JSON.stringify(d).replace(/</g, "\\u003c");

  return (
    `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><title>${esc(selected ? selected.title : "Dashboard")} · usac</title>` +
    `<style>${CSS}</style></head><body>` +
    `<aside><div class="brand">usac</div>` +
    `<h2>Stories</h2>${storyLinks}` +
    `<h2>Datenbank</h2>${tableLinks}` +
    `<h2>Navigation</h2>${nav}</aside>` +
    `<main><div class="top"><div><div class="count">Dashboard</div><h1 style="margin:2px 0 0;font-size:20px">${esc(selected ? selected.title : "Alle Schritte")}</h1></div>` +
    `<span id="pill" class="pill"><span class="dot"></span> CONNECTED · vor 0 s</span></div>` +
    `<div class="grid">` +
    `<div class="tile"><div class="lbl">Schritte</div><div class="val" id="t-steps">${d.steps.length}</div></div>` +
    `<div class="tile"><div class="lbl">Erfolgreich</div><div class="val" id="t-ok">${d.steps.filter((s) => s.ok).length}</div></div>` +
    `<div class="tile"><div class="lbl">Dateien</div><div class="val" id="t-files">${new Set(d.steps.flatMap((s) => s.files)).size}</div></div>` +
    `</div>` +
    `<section class="card"><h2>Verlauf</h2><div id="steps"></div></section>` +
    `<section class="card"><h2>Datenbank · Einblender (live)</h2><table><thead><tr><th>id</th><th>zeit</th><th>typ</th><th>akteur</th></tr></thead><tbody id="events"></tbody></table></section>` +
    `</main>` +
    `<script type="application/json" id="initial">${initial}</script>` +
    `<script>${SCRIPT}</script>` +
    `</body></html>`
  );
}
