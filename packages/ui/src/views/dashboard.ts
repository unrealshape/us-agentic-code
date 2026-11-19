import type { Store } from "../../../daemon/src/store";
import { esc } from "../html";

export type DashboardView = "story" | "tokens" | "sessions" | "diagnose";
export const DASHBOARD_VIEWS: DashboardView[] = ["story", "tokens", "sessions", "diagnose"];

type Tokens = { input: number; output: number };

/** Daten fuer das Dashboard. Die Felder je Seite kommen nur, wenn die Seite sie braucht. */
/** Zeitraeume fuer die Token-Ansicht in Stunden; "all" = ohne Begrenzung. */
const RANGES: Record<string, number> = { "1h": 1, "8h": 8, "24h": 24, "7d": 168, "30d": 720 };

export function dashboardData(store: Store, opts: { storyId?: string; view?: string; range?: string } = {}) {
  const view: DashboardView = (DASHBOARD_VIEWS as string[]).includes(opts.view ?? "") ? (opts.view as DashboardView) : "story";
  const workitems = store.listWorkItems();
  const stories = workitems.map((w) => ({ id: w.id, title: w.title, type: w.type, status: w.status, size: w.size, createdAt: w.createdAt }));
  const titles = new Map(workitems.map((w) => [w.id, w.title]));
  const base = {
    view,
    stories,
    story: opts.storyId ?? null,
    tables: store.tableCounts(),
    events: store.recentEvents(30).map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, traceId: e.traceId })),
    now: new Date().toISOString(),
  };

  if (view === "tokens") {
    const range = RANGES[opts.range ?? ""] ? (opts.range as string) : "all";
    const since = range === "all" ? null : Date.now() - RANGES[range]! * 3_600_000;
    const steps = store.listSteps().filter((s) => since === null || Date.parse(s.endedAt) >= since);
    const paths = new Map(workitems.map((w) => [w.id, w.projectPath]));
    const perProject = new Map<string, number>();
    for (const s of steps) {
      const p = paths.get(s.workItemId) ?? "unbekannt";
      perProject.set(p, (perProject.get(p) ?? 0) + s.tokens.input + s.tokens.output);
    }
    const byProject = [...perProject.entries()]
      .map(([path, total]) => ({ project: path.split(/[\\/]/).filter(Boolean).pop() ?? path, path, total }))
      .sort((a, b) => b.total - a.total);
    const perModel = new Map<string, Tokens>();
    for (const s of steps) {
      const m = perModel.get(s.model) ?? { input: 0, output: 0 };
      perModel.set(s.model, { input: m.input + s.tokens.input, output: m.output + s.tokens.output });
    }
    const byModel = [...perModel.entries()]
      .map(([model, t]) => ({ model, input: t.input, output: t.output, total: t.input + t.output }))
      .sort((a, b) => b.total - a.total);
    let running = 0;
    const series = [...steps]
      .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
      .map((s) => {
        running += s.tokens.input + s.tokens.output;
        return { at: s.endedAt, total: running };
      });
    const totals = steps.reduce((t, s) => ({ input: t.input + s.tokens.input, output: t.output + s.tokens.output }), { input: 0, output: 0 });
    return { ...base, range, totals: { ...totals, total: totals.input + totals.output }, byModel, series, byProject };
  }

  if (view === "sessions") {
    const sessions = store.listSteps().map((s) => ({
      storyId: s.workItemId,
      story: titles.get(s.workItemId) ?? s.workItemId,
      role: s.role,
      model: s.model,
      ok: s.ok,
      reason: s.reason ?? null,
      sliceId: s.sliceId ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      tokens: s.tokens,
    }));
    return { ...base, sessions };
  }

  if (view === "diagnose") {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    let counts: Record<string, number> = {};
    try {
      counts = store.tableCounts();
      checks.push({ name: "Datenbank erreichbar", ok: true, detail: "Abfrage ohne Fehler" });
    } catch (e) {
      checks.push({ name: "Datenbank erreichbar", ok: false, detail: String(e) });
    }
    const required = ["events", "workitems", "steps", "gate_results", "approvals"];
    const missing = required.filter((t) => !(t in counts));
    checks.push({ name: "Tabellen vollständig", ok: missing.length === 0, detail: missing.length ? `fehlt: ${missing.join(", ")}` : "alle vorhanden" });
    const steps = store.listSteps();
    checks.push({ name: "Schritte gespeichert", ok: steps.length > 0, detail: `${steps.length} Schritte` });
    const withTokens = steps.filter((s) => s.tokens.input + s.tokens.output > 0).length;
    checks.push({ name: "Tokens erfasst", ok: withTokens > 0, detail: `${withTokens} von ${steps.length} Schritten` });
    checks.push({ name: "Events vorhanden", ok: (counts.events ?? 0) > 0, detail: `${counts.events ?? 0} Events` });
    return { ...base, checks };
  }

  const steps = store.listSteps(opts.storyId);
  const slices = opts.storyId ? store.listSlices(opts.storyId) : [];
  return { ...base, slices, steps };
}

const NAV: [string, string][] = [
  ["/", "Inbox"],
  ["/wall", "Agent-Wand"],
  ["/metrics", "Metriken"],
  ["/knowledge", "Wissen"],
];

const CSS = `
:root{--bg:#0a0d12;--panel:#12171f;--panel2:#171e28;--line:#202a37;--text:#dfe5ee;--muted:#7a8595;--ok:#3ddc84;--run:#4aa3ff;--warn:#ffb020;--err:#ff5c5c;--cyan:#33d1e6;--purple:#a66bff;--amber:#ffc83d;--radius:12px;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;display:grid;grid-template-columns:250px 1fr;min-height:100vh}
aside{background:var(--panel);border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:13px;margin:0 6px 22px}
.logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--purple),var(--cyan));display:inline-block}
aside h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:22px 8px 8px;font-weight:700}
aside a.item{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--text);text-decoration:none;padding:9px 10px;border-radius:8px;font-size:13.5px}
aside a.item:hover{background:var(--panel2)}
aside a.item.sel{background:var(--panel2);box-shadow:inset 3px 0 0 var(--cyan)}
aside .sub{display:block;color:var(--muted);font-size:11.5px}
.count{color:var(--muted);font-size:12px}
main{padding:22px 28px 64px;min-width:0}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}
.kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}
h1{margin:4px 0 0;font-size:22px;font-weight:700}
.pill{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:7px 14px;border-radius:999px;background:var(--panel);border:1px solid var(--line);white-space:nowrap}
.pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);margin-right:6px}
.pill.off .dot{background:var(--err);box-shadow:0 0 8px var(--err)}
.btn{display:inline-block;background:var(--amber);color:#1a1400;font-weight:700;border:0;border-radius:8px;padding:8px 14px;text-decoration:none;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.tile .lbl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
.tile .val{font-size:26px;font-weight:700;margin-top:6px}
.tile .sub2{color:var(--muted);font-size:12px;margin-top:2px}
.dot-c{width:8px;height:8px;border-radius:2px;display:inline-block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:16px}
.card h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:700}
.row2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
@media (max-width:980px){.row2{grid-template-columns:1fr}}
.step{display:grid;grid-template-columns:18px 1fr auto;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.light{width:9px;height:9px;border-radius:50%;background:var(--muted);margin-top:6px}
.light.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.light.err{background:var(--err);box-shadow:0 0 8px var(--err)}
.light.warn{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.step .role{font-weight:600}
.step .meta{color:var(--muted);font-size:12px}
.step .files{margin-top:4px;font:12px ui-monospace,Consolas,monospace}
.step .reason{color:var(--err);font-size:12px;margin-top:4px}
table{width:100%;border-collapse:collapse;font:13px ui-monospace,Consolas,monospace}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-family:inherit}
tr.new td{animation:flash 2.4s ease-out}
@keyframes flash{from{background:rgba(51,209,230,.25)}to{background:transparent}}
.empty{color:var(--muted);padding:18px;border:1px dashed var(--line);border-radius:var(--radius);text-align:center}
svg text{fill:var(--muted);font:11px system-ui,sans-serif}
.legend{display:grid;gap:10px;margin-top:10px}
.legend div{display:flex;align-items:center;gap:8px;font-size:13px}
.legend b{margin-left:auto}
.check{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}
.check:last-child{border-bottom:0}
@media (max-width:760px){body{grid-template-columns:1fr}aside{position:static;height:auto}main{padding:16px}}
`;

const PALETTE = ["#a66bff", "#33d1e6", "#ffc83d", "#4aa3ff", "#3ddc84"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`;
  return String(n);
}

function timeOf(iso: string): string {
  return iso.slice(11, 19);
}

/** Flaechendiagramm der kumulierten Tokens, serverseitig gerendert. */
function tokenChart(series: { at: string; total: number }[]): string {
  if (series.length === 0) return `<div class="empty">Noch keine Token-Daten.</div>`;
  const W = 640;
  const H = 220;
  const max = Math.max(...series.map((p) => p.total), 1);
  const pts = series.map((p, i) => {
    const x = series.length === 1 ? W / 2 : (i * W) / (series.length - 1);
    const y = H - 24 - (p.total / max) * (H - 40);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${H - 24} ${line} ${W},${H - 24}`;
  const first = series[0]!.at.slice(11, 16);
  const last = series[series.length - 1]!.at.slice(11, 16);
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Tokens im Verlauf">` +
    `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#33d1e6" stop-opacity=".35"/><stop offset="1" stop-color="#33d1e6" stop-opacity="0"/></linearGradient></defs>` +
    `<polygon points="${area}" fill="url(#g)"/>` +
    `<polyline points="${line}" fill="none" stroke="#33d1e6" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<text x="0" y="${H - 4}">${esc(first)}</text><text x="${W}" y="${H - 4}" text-anchor="end">${esc(last)}</text>` +
    `<text x="${W}" y="14" text-anchor="end">${esc(fmt(max))}</text>` +
    `</svg>`
  );
}

/** Ring-Diagramm der Modell-Verteilung. */
function donut(byModel: { model: string; total: number }[]): string {
  const sum = byModel.reduce((t, m) => t + m.total, 0);
  const C = 2 * Math.PI * 70;
  if (sum === 0) return `<div class="empty">Keine Daten.</div>`;
  let offset = 0;
  const arcs = byModel
    .map((m, i) => {
      const len = (m.total / sum) * C;
      const arc = `<circle cx="100" cy="100" r="70" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
      offset += len;
      return arc;
    })
    .join("");
  return `<svg viewBox="0 0 200 200" width="180" height="180" role="img" aria-label="Tokens nach Modell">${arcs}</svg>`;
}

function layout(view: DashboardView, d: ReturnType<typeof dashboardData>, storyId: string | undefined, body: string, title: string): string {
  const storyLinks =
    d.stories
      .map(
        (s) =>
          `<a class="item${view === "story" && s.id === storyId ? " sel" : ""}" href="/dashboard?story=${encodeURIComponent(s.id)}"><span>${esc(s.title)}<span class="sub">${esc(s.type)} · ${esc(s.status)}</span></span></a>`,
      )
      .join("") || `<p class="count" style="padding:0 8px">Noch keine Stories.</p>`;
  const tableLinks = Object.entries(d.tables)
    .map(([t, n]) => `<a class="item" href="#"><span>${esc(t)}</span><span class="count">${n}</span></a>`)
    .join("");
  const viewLink = (v: DashboardView, label: string, sub: string) =>
    `<a class="item${view === v ? " sel" : ""}" href="/dashboard?view=${v}"><span>${esc(label)}<span class="sub">${esc(sub)}</span></span></a>`;
  const nav = NAV.map(([href, label]) => `<a class="item" href="${href}"><span>${esc(label)}</span></a>`).join("");
  const initial = JSON.stringify(d).replace(/</g, "\\u003c");
  const titleHtml = esc(title);
  return (
    `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><title>${titleHtml} · usac</title>` +
    `<style>${CSS}</style></head><body>` +
    `<aside><div class="brand"><span class="logo"></span>usac</div>` +
    `<h2>Stories</h2>${storyLinks}` +
    `<h2>Datenbank</h2>${tableLinks}` +
    `<h2>Auswertung</h2>${viewLink("tokens", "Token-Metriken", "Verbrauch und Modelle")}${viewLink("sessions", "Sessions", "alle Rollen-Aufrufe")}` +
    `<h2>Entwickler</h2>${viewLink("diagnose", "Diagnose", "Datenbank und Werkzeuge prüfen")}` +
    `<h2>Navigation</h2>${nav}</aside>` +
    `<main>${body}</main>` +
    `<script type="application/json" id="initial">${initial}</script>` +
    `<script>${SCRIPT}</script>` +
    `</body></html>`
  );
}

/** Client-Teil der Story-Seite: rendert aus /api/dashboard neu, markiert neue Events, zeigt Live-Status. */
const SCRIPT = `
(function(){
  var params = new URLSearchParams(location.search);
  var story = params.get("story");
  var view = params.get("view") || "story";
  var seen = null, lastOk = Date.now(), data = JSON.parse(document.getElementById("initial").textContent);
  function el(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text !== undefined) n.textContent = text; return n; }
  function render(d){
    if(!document.getElementById("steps")) return;
    var sl = document.getElementById("slices"); sl.textContent = "";
    if(!d.slices.length){ sl.appendChild(el("div","empty","Kein Slice-Plan für diese Auswahl.")); }
    d.slices.forEach(function(s){
      var row = el("div","step");
      row.appendChild(el("span","light "+(s.status==="green"?"ok":s.status==="red"?"err":"")));
      var mid = el("div");
      mid.appendChild(el("div","role", s.id + " · " + s.title));
      mid.appendChild(el("div","meta", "Kriterien: " + s.criteria.join(", ") + (s.dependsOn.length ? " · nach " + s.dependsOn.join(", ") : "")));
      if(s.files.length) mid.appendChild(el("div","files", s.files.join("  ·  ")));
      row.appendChild(mid);
      row.appendChild(el("span","count", s.status));
      sl.appendChild(row);
    });
    var steps = document.getElementById("steps"); steps.textContent = "";
    if(!d.steps.length){ steps.appendChild(el("div","empty","Noch keine Schritte für diese Auswahl.")); }
    d.steps.forEach(function(s){
      var row = el("div","step");
      row.appendChild(el("span","light "+(s.ok?"ok":"err")));
      var mid = el("div");
      mid.appendChild(el("div","role", s.role));
      mid.appendChild(el("div","meta", s.model + (s.sliceId ? " · " + s.sliceId : "") + " · " + s.startedAt.slice(11,19) + "–" + s.endedAt.slice(11,19)));
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
    if(view !== "story") { lastOk = Date.now(); return; }
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

export function dashboardHtml(store: Store, opts: { storyId?: string; view?: string; range?: string } = {}): string {
  const d = dashboardData(store, opts);
  const view = d.view;
  const selected = opts.storyId ? d.stories.find((s) => s.id === opts.storyId) : undefined;
  const pill = `<span id="pill" class="pill"><span class="dot"></span> CONNECTED · vor 0 s</span>`;

  if (view === "tokens") {
    const t = (d as { totals: { input: number; output: number; total: number } }).totals;
    const byModel = (d as { byModel: { model: string; input: number; output: number; total: number }[] }).byModel;
    const series = (d as { series: { at: string; total: number }[] }).series;
    const sum = byModel.reduce((a, m) => a + m.total, 0);
    const range = (d as { range: string }).range;
    const byProject = (d as { byProject: { project: string; path: string; total: number }[] }).byProject;
    const rangeLinks = ["1h", "8h", "24h", "7d", "30d", "all"]
      .map(
        (r) =>
          `<a class="item${range === r ? " sel" : ""}" style="display:inline-block;width:auto;padding:6px 12px;margin-right:4px;border:1px solid var(--line);border-radius:8px" href="/dashboard?view=tokens&range=${r}">${r === "all" ? "Gesamt" : r}</a>`,
      )
      .join("");
    const projectRows = byProject
      .map((p) => `<tr><td>${esc(p.project)}</td><td>${esc(p.path)}</td><td>${esc(fmt(p.total))}</td></tr>`)
      .join("");
    const legend = byModel
      .map(
        (m, i) =>
          `<div><span class="dot-c" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(m.model)}<b>${fmt(m.total)} · ${sum ? Math.round((m.total / sum) * 100) : 0} %</b></div>`,
      )
      .join("");
    const body =
      `<div class="top"><div><div class="kicker">Auswertung</div><h1>Token-Metriken</h1></div>${pill}</div>` +
      `<div style="margin-bottom:14px">${rangeLinks}</div>` +
      `<div class="grid">` +
      `<div class="tile"><div class="lbl"><span class="dot-c" style="background:var(--cyan)"></span>Gesamt</div><div class="val">${fmt(t.total)}</div><div class="sub2">alle Schritte</div></div>` +
      `<div class="tile"><div class="lbl"><span class="dot-c" style="background:var(--purple)"></span>Input</div><div class="val">${fmt(t.input)}</div></div>` +
      `<div class="tile"><div class="lbl"><span class="dot-c" style="background:var(--amber)"></span>Output</div><div class="val">${fmt(t.output)}</div></div>` +
      `</div>` +
      `<div class="row2"><section class="card"><h2>Tokens im Verlauf</h2>${tokenChart(series)}</section>` +
      `<section class="card"><h2>Tokens nach Modell</h2><div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">${donut(byModel)}  <div class="legend" style="flex:1;min-width:180px">${legend || '<div class="empty">Keine Daten</div>'}</div></div></section></div>` +
      `<section class="card"><h2>Tokens je Projekt</h2>${projectRows ? `<table><thead><tr><th>Projekt</th><th>Pfad</th><th>Tokens</th></tr></thead><tbody>${projectRows}</tbody></table>` : '<div class="empty">Keine Daten im Zeitraum.</div>'}</section>`;
    return layout(view, d, opts.storyId, body, "Token-Metriken");
  }

  if (view === "sessions") {
    const rows = (d as { sessions: { startedAt: string; story: string; role: string; model: string; ok: boolean; sliceId: string | null; tokens: Tokens }[] }).sessions
      .map(
        (s) =>
          `<tr><td>${esc(timeOf(s.startedAt))}</td><td>${esc(s.story)}</td><td>${esc(s.role)}</td><td>${esc(s.model)}</td><td>${esc(s.sliceId ?? "–")}</td><td>${s.ok ? '<span class="light ok" style="margin:0 8px 0 0;vertical-align:middle"></span>ok' : '<span class="light err" style="margin:0 8px 0 0;vertical-align:middle"></span>fehlgeschlagen'}</td><td>${esc(fmt(s.tokens.input + s.tokens.output))}</td></tr>`,
      )
      .join("");
    const body =
      `<div class="top"><div><div class="kicker">Auswertung</div><h1>Sessions</h1></div>${pill}</div>` +
      `<section class="card">${rows ? `<table><thead><tr><th>Zeit</th><th>Story</th><th>Rolle</th><th>Modell</th><th>Slice</th><th>Ergebnis</th><th>Tokens</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Noch keine Sessions.</div>'}</section>`;
    return layout(view, d, opts.storyId, body, "Sessions");
  }

  if (view === "diagnose") {
    const checks = (d as { checks: { name: string; ok: boolean; detail: string }[] }).checks
      .map(
        (c) =>
          `<div class="check"><span class="light ${c.ok ? "ok" : "warn"}"></span><div><div style="font-weight:600">${esc(c.name)}</div><div class="meta muted" style="font-size:12px">${esc(c.detail)}</div></div></div>`,
      )
      .join("");
    const body =
      `<div class="top"><div><div class="kicker">Entwickler</div><h1>Diagnose</h1></div>` +
      `<div style="display:flex;gap:10px;align-items:center">${pill}<a class="btn" href="/dashboard?view=diagnose">Erneut prüfen</a></div></div>` +
      `<section class="card"><h2>Prüfungen</h2>${checks}</section>`;
    return layout(view, d, opts.storyId, body, "Diagnose");
  }

  const title = selected ? selected.title : "Alle Schritte";
  const storyView = d as { slices: unknown[]; steps: { ok: boolean; files: string[] }[] };
  const okCount = storyView.steps.filter((s) => s.ok).length;
  const files = new Set(storyView.steps.flatMap((s) => s.files)).size;
  const body =
    `<div class="top"><div><div class="kicker">Story</div><h1>${esc(title)}</h1></div>${pill}</div>` +
    `<div class="grid">` +
    `<div class="tile"><div class="lbl">Schritte</div><div class="val" id="t-steps">${storyView.steps.length}</div></div>` +
    `<div class="tile"><div class="lbl">Erfolgreich</div><div class="val" id="t-ok">${okCount}</div></div>` +
    `<div class="tile"><div class="lbl">Dateien</div><div class="val" id="t-files">${files}</div></div>` +
    `</div>` +
    `<section class="card"><h2>Slices</h2><div id="slices"></div></section>` +
    `<section class="card"><h2>Verlauf</h2><div id="steps"></div></section>` +
    `<section class="card"><h2>Datenbank · Einblender (live)</h2><table><thead><tr><th>id</th><th>zeit</th><th>typ</th><th>akteur</th></tr></thead><tbody id="events"></tbody></table></section>`;
  return layout(view, d, opts.storyId, body, selected ? selected.title : "Dashboard");
}
