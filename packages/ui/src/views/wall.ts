import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

export function wallData(store: Store) {
  return { items: store.listWorkItems() };
}

export function wallHtml(store: Store): string {
  const rows = wallData(store)
    .items.map((i) => {
      const enc = encodeURIComponent(i.id);
      return `<li><a href="/runs/${enc}">${esc(i.id)}</a> ${esc(i.title)} [${esc(i.status)}] <a href="/runs/${enc}/pipeline">Pipeline</a></li>`;
    })
    .join("");
  return page("Agent-Wand", `<h1>Agent-Wand</h1><ul>${rows || "<li>Keine Runs</li>"}</ul>`);
}
