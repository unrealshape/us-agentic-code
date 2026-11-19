// Metrik-Ansicht (Phase 5, ADR 0010): Velocity, Eskalationsrate, Wartezeit, Tokens je Rolle/Modell.
// Jede Grafik (inline SVG, ohne Chart-Bibliothek) hat eine Tabelle mit denselben Zahlen.
// Vorschlaege zum Herabstufen kommen aus `suggestDowngrades` und sind nur Anzeige; uebernommen wird
// nichts von dieser Seite.
import type { Hono } from "hono";
import type { Store } from "../../../daemon/src/store";
import { computeMetrics, type Metrics, type MetricsOptions } from "../../../daemon/src/metrics";
import { suggestDowngrades } from "../../../daemon/src/downgrade";
import type { RoutingConfig } from "../../../daemon/src/routing";
import { esc, page } from "../html";

/** Stil kommt aus html.ts (Kontrollraum). Hier nur Grafik- und Tabellenregeln. */
const STYLE = `<style>
svg text{fill:var(--muted);font-size:12px}
svg rect.bar{fill:var(--run)}
figure{margin:0 0 16px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
figcaption{color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
table{margin:8px 0 18px}
</style>`;

const BAR_ROW = 26;
const LABEL_W = 220;
const BAR_W = 260;

type Bar = { label: string; value: number; shown: string };

/** Waagrechte Balken als inline SVG plus Tabelle mit denselben Zahlen. Leere Daten: nur Hinweis. */
function barFigure(caption: string, bars: Bar[]): string {
  if (!bars.length) return `<figure><figcaption>${esc(caption)}</figcaption><p>Keine Daten</p></figure>`;
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  const height = bars.length * BAR_ROW + 8;
  const rows = bars
    .map((b, i) => {
      const y = i * BAR_ROW + 4;
      const w = Math.max(0, (b.value / max) * BAR_W);
      return (
        `<text x="0" y="${y + 16}">${esc(b.label)}</text>` +
        `<rect class="bar" x="${LABEL_W}" y="${y}" width="${w.toFixed(1)}" height="16"></rect>` +
        `<text x="${LABEL_W + BAR_W + 8}" y="${y + 13}">${esc(b.shown)}</text>`
      );
    })
    .join("");
  const svg =
    `<svg role="img" aria-label="${esc(caption)}" width="${LABEL_W + BAR_W + 120}" height="${height}" viewBox="0 0 ${LABEL_W + BAR_W + 120} ${height}">` +
    `${rows}</svg>`;
  const table =
    `<table><tr><th>${esc(caption)}</th><th>Wert</th></tr>` +
    bars.map((b) => `<tr><td>${esc(b.label)}</td><td>${esc(b.shown)}</td></tr>`).join("") +
    `</table>`;
  return `<figure><figcaption>${esc(caption)}</figcaption>${svg}${table}</figure>`;
}

const pct = (x: number): string => `${Math.round(x * 100)} %`;

function sprintsSection(m: Metrics): string {
  const velocity = barFigure(
    "Velocity (erledigte Auftraege je Sprint)",
    m.sprints.map((s, i) => ({ label: `Sprint ${i + 1} (ab ${s.start.slice(0, 10)})`, value: s.done, shown: String(s.done) })),
  );
  const escalation = barFigure(
    "Eskalationsrate je Sprint",
    m.sprints.map((s, i) => ({ label: `Sprint ${i + 1}`, value: s.escalationRate * 100, shown: pct(s.escalationRate) })),
  );
  return `<h2>Sprints</h2>${velocity}${escalation}`;
}

function waitSection(m: Metrics): string {
  return barFigure(
    "Wartezeit auf Freigaben (Median je Art)",
    m.approvalWait.map((w) => ({
      label: `${w.kind} (${w.count})`,
      value: w.medianMs / 60_000,
      shown: `${(w.medianMs / 60_000).toFixed(1)} min`,
    })),
  );
}

function tokenSection(m: Metrics): string {
  return barFigure(
    "Tokens je Rolle und Modell",
    m.roles.map((r) => ({ label: `${r.role} (${r.model})`, value: r.tokens, shown: String(r.tokens) })),
  );
}

function roleTable(m: Metrics): string {
  const rows = m.roles
    .map(
      (r) =>
        `<tr><td>${esc(r.role)}</td><td>${esc(r.model)}</td><td>${r.runs}</td><td>${r.okRuns}</td>` +
        `<td>${pct(r.firstPassRate)}</td><td>${r.escalations}</td><td>${r.tokens}</td><td>${r.avgTurns.toFixed(1)}</td></tr>`,
    )
    .join("");
  return (
    `<h2>Rollen und Modelle</h2><table><tr><th>Rolle</th><th>Modell</th><th>Laeufe</th><th>Ok</th>` +
    `<th>Erstversuch</th><th>Eskalationen</th><th>Tokens</th><th>Ø Turns</th></tr>${rows || ""}</table>`
  );
}

function downgradeSection(m: Metrics, routing: RoutingConfig): string {
  const items = suggestDowngrades(m.roles, routing).map((s) => {
    const who = s.variant ? `${s.role}.${s.variant}` : s.role;
    const e = s.evidence;
    return (
      `<li>${esc(who)}: ${esc(s.from)} → ${esc(s.to)} ` +
      `(Belege: ${e.runs} Laeufe, Erstversuch ${pct(e.firstPassRate)}, ${e.escalations} Eskalationen)</li>`
    );
  });
  return `<h2>Vorschläge zum Herabstufen</h2><div class="card">${items.length ? `<ul>${items.join("")}</ul>` : `<p class="muted">Keine Vorschläge.</p>`}</div>`;
}

/** Vollstaendige Metrik-Seite. Liest das Event-Log, rechnet nichts ausserhalb von `computeMetrics`/`suggestDowngrades`. */
export function metricsHtml(store: Store, routing: RoutingConfig, opts: MetricsOptions): string {
  const m = computeMetrics(store.events(), opts);
  const body =
    `${STYLE}<h1>Metriken</h1>` +
    sprintsSection(m) +
    waitSection(m) +
    tokenSection(m) +
    roleTable(m) +
    downgradeSection(m, routing);
  return page("Metriken", body);
}

/** Registriert `GET /metrics`. Die Verdrahtung in den Server-Start folgt in Task 10. */
export function registerMetrics(app: Hono, deps: { store: Store; routing: RoutingConfig; sprintStart: Date; sprintDays: number }): void {
  app.get("/metrics", (c) =>
    c.html(metricsHtml(deps.store, deps.routing, { sprintStart: deps.sprintStart, sprintDays: deps.sprintDays, now: new Date() })),
  );
}
