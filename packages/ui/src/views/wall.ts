import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

export function wallData(store: Store) {
  return { items: store.listWorkItems() };
}

const ACTIVE = ["running", "queued", "implementing", "review"];
const PROBLEM = ["failed", "escalated"];
const LIGHT: Record<string, string> = { done: "ok", failed: "err", escalated: "warn" };

/** Kachel: die Auswahl ist eine echte Schaltfläche; Details und Pipeline bleiben eigene Links. */
function tile(i: { id: string; title: string; status: string }): string {
  const enc = encodeURIComponent(i.id);
  return (
    `<div class="tile"><button type="button" class="pick" data-run="${esc(i.id)}" aria-pressed="false">` +
    `<span class="id">${esc(i.id)}</span><span class="t">${esc(i.title)}</span></button>` +
    `<span class="light ${LIGHT[i.status] ?? "run"}"></span><span class="muted">${esc(i.status)}</span> ` +
    `<a href="/runs/${enc}">Details</a> · <a href="/runs/${enc}/pipeline">Pipeline</a></div>`
  );
}

function column(title: string, items: { id: string; title: string; status: string }[]): string {
  return `<section class="col"><h2><span>${esc(title)}</span><span>${items.length}</span></h2>${
    items.map(tile).join("") || `<div class="muted">–</div>`
  }</section>`;
}

/**
 * Klick auf eine Kachel lädt `/api/runs/:id` und zeigt die Ereignisse darunter; die Seite
 * wird dabei nicht neu geladen. Texte werden per textContent gesetzt, nie als HTML.
 */
const SCRIPT = `<script>
(function () {
  var detail = document.getElementById("run-detail");
  var picks = document.querySelectorAll("button[data-run]");
  var current = 0;
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function show(nodes) { detail.replaceChildren.apply(detail, nodes); }
  picks.forEach(function (b) {
    b.addEventListener("click", function () {
      var seq = ++current;
      var id = b.dataset.run;
      picks.forEach(function (x) {
        var on = x === b;
        x.setAttribute("aria-pressed", on ? "true" : "false");
        x.closest(".tile").classList.toggle("sel", on);
      });
      show([el("p", "Lade Ereignisse von " + id + " ...", "muted")]);
      fetch("/api/runs/" + encodeURIComponent(id))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (run) {
          if (seq !== current) return;
          var list = document.createElement("ol");
          list.className = "events";
          run.events.forEach(function (e) {
            list.appendChild(el("li", e.ts + " " + e.type + " (" + e.actor + ") " + JSON.stringify(e.data)));
          });
          var nodes = [el("h2", "Run " + id)];
          nodes.push(run.events.length ? list : el("p", "Keine Ereignisse.", "muted"));
          show(nodes);
        })
        .catch(function (e) {
          if (seq !== current) return;
          show([el("p", "Ereignisse konnten nicht geladen werden: " + e.message, "warn")]);
        });
    });
  });
})();
</script>`;

export function wallHtml(store: Store): string {
  const items = wallData(store).items;
  const active = items.filter((i) => ACTIVE.includes(i.status));
  const problems = items.filter((i) => PROBLEM.includes(i.status));
  const done = items.filter((i) => !ACTIVE.includes(i.status) && !PROBLEM.includes(i.status));
  const body = items.length
    ? `<div class="cols">${column("Aktiv", active)}${column("Probleme", problems)}${column("Abgeschlossen", done)}</div>` +
      `<section class="detail" id="run-detail" aria-live="polite"><p class="muted">Kachel wählen, um die Ereignisse des Runs zu sehen.</p></section>` +
      SCRIPT
    : `<div class="empty">Keine Runs.</div>`;
  return page("Agent-Wand", `<h1>Agent-Wand</h1>${body}`);
}
