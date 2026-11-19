import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

const WARNING_TYPES = new Set(["budget.exceeded"]);

export function runData(store: Store, id: string) {
  const events = store.events({ traceId: id });
  return { id, events, warnings: events.filter((e) => WARNING_TYPES.has(e.type)) };
}

export function runHtml(store: Store, id: string): string {
  const { events, warnings } = runData(store, id);
  const warn = warnings
    .map((w) => `<p class="warn">Warnung: ${esc(w.type)} ${esc(JSON.stringify(w.data))}</p>`)
    .join("");
  const rows = events.map((e) => `<li>${esc(e.ts)} ${esc(e.type)} (${esc(e.actor)}) ${esc(JSON.stringify(e.data))}</li>`).join("");
  const enc = encodeURIComponent(id);
  const links = `<p><a href="/runs/${enc}/pipeline">Pipeline</a> · <a href="/runs/${enc}/review">Review</a></p>`;
  return page(`Run ${id}`, `<h1>Run ${esc(id)}</h1>${links}${warn}<div class="card"><ol class="events">${rows}</ol></div>`);
}
