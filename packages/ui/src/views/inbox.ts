import type { Store } from "../../../daemon/src/store";

export function inboxData(store: Store) {
  return { approvals: store.pendingApprovals() };
}

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><nav><a href="/">Inbox</a> | <a href="/wall">Agent-Wand</a></nav>${body}</body></html>`;
}

export function inboxHtml(store: Store): string {
  const rows = inboxData(store)
    .approvals.map((a) => `<li>${esc(a.workItemId)}: ${esc(a.kind)}</li>`)
    .join("");
  return page("Inbox", `<h1>Inbox</h1><ul>${rows || "<li>Keine offenen Freigaben</li>"}</ul>`);
}
