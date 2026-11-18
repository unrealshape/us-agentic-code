import { existsSync } from "node:fs";
import type { Hono } from "hono";
import type { Evidence } from "../../../shared/src/index";
import type { Approval, GateResult, Store } from "../../../daemon/src/store";
import { git } from "../../../daemon/src/exec";
import { parseUnifiedDiff, renderDiff, type FileDiff, type ReviewFinding } from "../diff";
import { esc, page } from "../html";
import type { Guard } from "../actions";

export type ReviewData = {
  files: FileDiff[];
  findings: ReviewFinding[];
  gates: GateResult[];
  approval?: Approval;
  unavailable?: string;
};

export const WORKTREE_GONE = "Worktree nicht mehr vorhanden (nach Merge entfernt)";

function asFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .filter((f) => typeof f.severity === "string" && typeof f.text === "string")
    .map((f) => ({
      severity: f.severity as string,
      text: f.text as string,
      evidence: (Array.isArray(f.evidence) ? f.evidence : []).filter(
        (e): e is Evidence => !!e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string",
      ),
    }));
}

/**
 * Befunde der juengsten Review-Runde (`review.seat`, `review.adr` nach dem letzten
 * `review.triggers`) und des juengsten Security-Reviews.
 */
function latestFindings(store: Store, workItemId: string): ReviewFinding[] {
  const events = store.events({ traceId: workItemId });
  let roundStart = -1;
  events.forEach((e, i) => {
    if (e.type === "review.triggers") roundStart = i;
  });
  const findings: ReviewFinding[] = [];
  events.forEach((e, i) => {
    if (i > roundStart && (e.type === "review.seat" || e.type === "review.adr")) {
      findings.push(...asFindings((e.data as { findings?: unknown })?.findings));
    }
  });
  const security = events.filter((e) => e.type === "security.review").at(-1);
  if (security) findings.push(...asFindings((security.data as { findings?: unknown })?.findings));
  return findings;
}

function gatesFor(store: Store, workItemId: string): GateResult[] {
  const ids = store.db.query("SELECT id FROM gate_results WHERE workitem_id = ? ORDER BY id").all(workItemId) as { id: number }[];
  return ids.map((r) => store.getGate(r.id)!);
}

/** Offene Freigabe des Auftrags, sonst die juengste. */
function approvalFor(store: Store, workItemId: string): Approval | undefined {
  const row = store.db
    .query("SELECT id FROM approvals WHERE workitem_id = ? ORDER BY (status = 'pending') DESC, id DESC LIMIT 1")
    .get(workItemId) as { id: number } | null;
  return row ? (store.getApproval(row.id) ?? undefined) : undefined;
}

/** Daten der Review-Ansicht: Diff `git diff <baseRef>..HEAD` im Worktree, Befunde, Gates, Freigabe. */
export async function reviewData(store: Store, workItemId: string): Promise<ReviewData> {
  const wi = store.getWorkItem(workItemId);
  if (!wi) return { files: [], findings: [], gates: [], unavailable: `Auftrag ${workItemId} nicht gefunden` };
  const base: Omit<ReviewData, "files"> = {
    findings: latestFindings(store, workItemId),
    gates: gatesFor(store, workItemId),
    approval: approvalFor(store, workItemId),
  };
  if (!base.approval) delete base.approval;
  if (!wi.worktree || !existsSync(wi.worktree)) return { ...base, files: [], unavailable: WORKTREE_GONE };
  const baseRef = (wi.state as { baseRef?: unknown }).baseRef;
  if (typeof baseRef !== "string" || !baseRef) return { ...base, files: [], unavailable: "Kein Basis-Commit bekannt" };
  try {
    const out = await git(wi.worktree, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", `${baseRef}..HEAD`);
    return { ...base, files: parseUnifiedDiff(out) };
  } catch (e) {
    return { ...base, files: [], unavailable: `Diff nicht lesbar: ${(e as Error).message}` };
  }
}

// Schreibende Aktionen laufen ueber POST /api/approvals/:id mit dem Token aus <meta name="usac-token">.
const SCRIPT = `<script>
document.querySelectorAll("button[data-approval]").forEach(function (b) {
  b.addEventListener("click", function () {
    var t = document.querySelector('meta[name="usac-token"]');
    var note = document.getElementById("approval-note");
    fetch("/api/approvals/" + b.dataset.approval, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Usac-Token": t ? t.content : "" },
      body: JSON.stringify({ granted: b.dataset.granted === "true", note: note && note.value ? note.value : undefined })
    }).then(function (r) { return r.text().then(function (x) { document.getElementById("approval-result").textContent = r.status + " " + x; }); });
  });
});
</script>`;

export function reviewHtmlFrom(workItemId: string, data: ReviewData, token?: string): string {
  const parts: string[] = [`<h1>Review ${esc(workItemId)}</h1>`];
  if (data.unavailable) parts.push(`<p class="warn">${esc(data.unavailable)}</p>`);
  const a = data.approval;
  if (a) {
    parts.push(`<section class="approval"><h2>Freigabe ${a.id} (${esc(a.kind)}): ${esc(a.status)}</h2>`);
    if (a.status === "pending") {
      parts.push(
        `<label>Notiz <input id="approval-note" type="text"></label> ` +
          `<button type="button" data-approval="${a.id}" data-granted="true">Freigeben</button> ` +
          `<button type="button" data-approval="${a.id}" data-granted="false">Ablehnen</button>` +
          `<p id="approval-result" role="status"></p>`,
      );
    } else if (a.note) parts.push(`<p>Notiz: ${esc(a.note)}</p>`);
    parts.push(`</section>`);
  }
  if (data.gates.length) {
    const rows = data.gates
      .map((g) => `<li>${esc(g.name)}: ${esc(g.status)} (Exit ${esc(g.exitCode)}, ${esc(g.durationMs)} ms)</li>`)
      .join("");
    parts.push(`<section class="gates"><h2>Gates</h2><ul>${rows}</ul></section>`);
  }
  parts.push(`<section class="diff"><h2>Diff</h2>${renderDiff(data.files, data.findings)}</section>`);
  if (a?.status === "pending") parts.push(SCRIPT);
  return page(`Review ${workItemId}`, parts.join(""), token !== undefined ? { token } : {});
}

/** GET /runs/:id/review; das Token steht nur in der Seite, nie in der URL. */
export function registerReview(app: Hono, store: Store, g?: Guard): void {
  app.get("/runs/:id/review", async (c) => {
    const id = c.req.param("id");
    return c.html(reviewHtmlFrom(id, await reviewData(store, id), g?.token));
  });
}
