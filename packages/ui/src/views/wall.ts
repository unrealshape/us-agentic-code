import type { Store } from "../../../daemon/src/store";
import { esc, page } from "./inbox";

export function wallData(store: Store) {
  return { items: store.listWorkItems() };
}

export function wallHtml(store: Store): string {
  const rows = wallData(store)
    .items.map((i) => `<li><a href="/runs/${encodeURIComponent(i.id)}">${esc(i.id)}</a> ${esc(i.title)} [${esc(i.status)}]</li>`)
    .join("");
  return page("Agent-Wand", `<h1>Agent-Wand</h1><ul>${rows || "<li>Keine Runs</li>"}</ul>`);
}
