import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

export function inboxData(store: Store) {
  return { approvals: store.pendingApprovals() };
}

/** Freigaben ohne Auftrag (Herabstufung, Nachtbericht) zeigen keinen Review-Link; sie werden in ihrer Art beschrieben. */
const NO_REVIEW = new Set(["routing_change", "night_report"]);

export function inboxHtml(store: Store): string {
  const rows = inboxData(store)
    .approvals.map((a) => {
      const label = `${esc(a.kind)} (Freigabe ${a.id})`;
      if (NO_REVIEW.has(a.kind)) return `<li>${label}: ${esc(a.workItemId)}</li>`;
      return `<li><a href="/runs/${encodeURIComponent(a.workItemId)}/review">${esc(a.workItemId)}</a>: ${label}</li>`;
    })
    .join("");
  return page("Inbox", `<h1>Inbox</h1><ul>${rows || "<li>Keine offenen Freigaben</li>"}</ul>`);
}
