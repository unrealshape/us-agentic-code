import type { Store } from "../../../daemon/src/store";
import { esc, page } from "../html";

export function inboxData(store: Store) {
  return { approvals: store.pendingApprovals() };
}

/** Freigaben ohne Auftrag (Herabstufung, Nachtbericht) zeigen keinen Review-Link; sie werden in ihrer Art beschrieben. */
const NO_REVIEW = new Set(["routing_change", "night_report"]);

/**
 * Schreibaktionen laufen ueber POST /api/approvals/:id mit dem Token aus <meta name="usac-token">.
 * Nach Erfolg wird die Zeile als erledigt markiert, bei Fehler steht der Grund in der Zeile.
 */
const SCRIPT = `<script>
document.querySelectorAll("button[data-approval]").forEach(function (b) {
  b.addEventListener("click", function () {
    var row = b.closest("li");
    var msg = row.querySelector(".rowmsg");
    var buttons = row.querySelectorAll("button[data-approval]");
    var t = document.querySelector('meta[name="usac-token"]');
    var granted = b.dataset.granted === "true";
    function enable() { buttons.forEach(function (x) { x.disabled = false; }); }
    buttons.forEach(function (x) { x.disabled = true; });
    msg.textContent = "";
    fetch("/api/approvals/" + b.dataset.approval, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Usac-Token": t ? t.content : "" },
      body: JSON.stringify({ granted: granted })
    }).then(function (r) {
      if (r.ok) {
        row.querySelector(".btns").textContent = granted ? "Freigegeben" : "Abgelehnt";
        return;
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        msg.textContent = "Fehler " + r.status + ": " + (j.error || "unbekannt");
        enable();
      });
    }).catch(function (e) {
      msg.textContent = "Netzwerkfehler: " + e.message;
      enable();
    });
  });
});
</script>`;

/**
 * Inbox. Mit `token` (Guard) gibt es je Freigabe die Buttons "Freigeben" und "Ablehnen"
 * und das Token als Meta-Tag; ohne Token bleibt die Seite rein lesend.
 */
export function inboxHtml(store: Store, token?: string): string {
  const interactive = token !== undefined;
  const rows = inboxData(store)
    .approvals.map((a) => {
      const label = `${esc(a.kind)} (Freigabe ${a.id})`;
      const link = NO_REVIEW.has(a.kind)
        ? `${label}: ${esc(a.workItemId)}`
        : `<a href="/runs/${encodeURIComponent(a.workItemId)}/review">${esc(a.workItemId)}</a>: ${label}`;
      if (!interactive) return `<li>${link}</li>`;
      return (
        `<li class="appr">${link} ` +
        `<span class="btns"><button type="button" class="act" data-approval="${a.id}" data-granted="true">Freigeben</button> ` +
        `<button type="button" class="act" data-approval="${a.id}" data-granted="false">Ablehnen</button></span> ` +
        `<span class="rowmsg" role="status"></span></li>`
      );
    })
    .join("");
  const body = `<h1>Inbox</h1><ul>${rows || "<li>Keine offenen Freigaben</li>"}</ul>${interactive && rows ? SCRIPT : ""}`;
  return page("Inbox", body, interactive ? { token } : {});
}
