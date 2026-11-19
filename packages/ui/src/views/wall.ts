import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

export function wallData(store: Store) {
  return { items: store.listWorkItems() };
}

const ACTIVE = ["running", "queued", "implementing", "review"];
const PROBLEM = ["failed", "escalated"];
const LIGHT: Record<string, string> = { done: "ok", failed: "err", escalated: "warn" };

function tile(i: { id: string; title: string; status: string }): string {
  const enc = encodeURIComponent(i.id);
  return (
    `<div class="tile"><a href="/runs/${enc}" class="id">${esc(i.id)}</a>` +
    `<div class="t">${esc(i.title)}</div>` +
    `<span class="light ${LIGHT[i.status] ?? "run"}"></span><span class="muted">${esc(i.status)}</span> ` +
    `<a href="/runs/${enc}/pipeline">Pipeline</a></div>`
  );
}

function column(title: string, items: { id: string; title: string; status: string }[]): string {
  return `<section class="col"><h2><span>${esc(title)}</span><span>${items.length}</span></h2>${
    items.map(tile).join("") || `<div class="muted">–</div>`
  }</section>`;
}

export function wallHtml(store: Store): string {
  const items = wallData(store).items;
  const active = items.filter((i) => ACTIVE.includes(i.status));
  const problems = items.filter((i) => PROBLEM.includes(i.status));
  const done = items.filter((i) => !ACTIVE.includes(i.status) && !PROBLEM.includes(i.status));
  const body = items.length
    ? `<div class="cols">${column("Aktiv", active)}${column("Probleme", problems)}${column("Abgeschlossen", done)}</div>`
    : `<div class="empty">Keine Runs.</div>`;
  return page("Agent-Wand", `<h1>Agent-Wand</h1>${body}`);
}
