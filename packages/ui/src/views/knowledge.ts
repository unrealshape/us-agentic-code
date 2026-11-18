import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Store } from "../../../daemon/src/store";
import { search, type Evidence, type MemoryEntry, type MemoryOrigin, type MemoryStatus } from "../../../daemon/src/memory";
import { listInstincts, type Instinct, type InstinctStatus } from "../../../daemon/src/instincts";
import { loadConstitution, type Constitution, type Rule } from "../../../daemon/src/rules";
import { listAdrs, type AdrInfo } from "../../../daemon/src/adr";
import { esc, page } from "../html";
import type { Guard } from "../actions";

/** Abhaengigkeiten der Wissens-Ansicht; `store` braucht nur die Aktionen (registrierte Projekte). */
export type KnowledgeDeps = { memory: Database; projectPath?: string; home: string; store?: Store };

export type KnowledgeData = { entries: MemoryEntry[]; instincts: Instinct[]; constitution: Constitution | null; adrs: AdrInfo[] };

/** So viele Memory-Eintraege zeigt die Ansicht ohne Suchbegriff (neueste zuerst). */
export const RECENT_LIMIT = 50;

type EntryRow = { id: number; uid: string; kind: string; text: string; status: string; origin: string; created_at: string; updated_at: string };

function recentEntries(db: Database): MemoryEntry[] {
  const rows = db
    .query("SELECT id, uid, kind, text, status, origin, created_at, updated_at FROM entries ORDER BY id DESC LIMIT ?")
    .all(RECENT_LIMIT) as EntryRow[];
  const ev = db.query("SELECT file, lines, quote, kind FROM evidence WHERE entry_id = ? ORDER BY rowid");
  return rows.map((r) => ({
    ...r,
    status: r.status as MemoryStatus,
    origin: r.origin as MemoryOrigin,
    evidence: ev.all(r.id) as Evidence[],
  }));
}

/**
 * Daten der Wissens-Ansicht. Ohne `query` die 50 neuesten Memory-Eintraege, mit `query` die
 * FTS-Suche. Verfassung (`CLAUDE.md`, Cache unter `<home>/rules-cache`) und ADRs (`docs/adr`)
 * nur mit `projectPath`.
 */
export function knowledgeData(deps: { memory: Database; projectPath?: string; home: string }, query?: string): KnowledgeData {
  const q = query?.trim();
  const entries = q ? search(deps.memory, q) : recentEntries(deps.memory);
  const instincts = listInstincts(deps.memory);
  const p = deps.projectPath;
  return {
    entries,
    instincts,
    constitution: p ? loadConstitution(p, join(deps.home, "rules-cache")) : null,
    adrs: p ? listAdrs(join(p, "docs", "adr")) : [],
  };
}

const INSTINCT_GROUPS: [InstinctStatus, string][] = [
  ["proposed", "Vorgeschlagen"],
  ["active", "Aktiv"],
  ["retired", "Stillgelegt"],
];

function evidenceHtml(e: Evidence): string {
  const where = e.kind === "approval" ? `Freigabe ${e.lines}` : `${e.file}:${e.lines}`;
  return `<li><code>${esc(where)}</code> <q>${esc(e.quote)}</q></li>`;
}

function memoryHtml(entries: MemoryEntry[], query: string): string {
  const form =
    `<form method="get" action="/knowledge" role="search"><label>Suche ` +
    `<input type="search" name="q" value="${esc(query)}"></label> <button type="submit">Suchen</button></form>`;
  const items = entries
    .map((e) => {
      const verify =
        e.status !== "verified" && e.uid
          ? ` <button type="button" data-verify="${esc(e.uid)}">Verifizieren</button>`
          : "";
      return (
        `<li><span class="status">${esc(e.status)}</span> <span class="kind">${esc(e.kind)}</span> ${esc(e.text)}${verify}` +
        `<ul class="evidence">${e.evidence.map(evidenceHtml).join("")}</ul></li>`
      );
    })
    .join("");
  const list = entries.length ? `<ul class="entries">${items}</ul>` : `<p>Keine Eintraege.</p>`;
  return `<section class="memory"><h2>Memory</h2>${form}${list}</section>`;
}

function instinctsHtml(instincts: Instinct[]): string {
  const groups = INSTINCT_GROUPS.map(([status, label]) => {
    const rows = instincts
      .filter((i) => i.status === status)
      .map((i) => {
        const glob = i.glob ? ` <code>${esc(i.glob)}</code>` : "";
        const reason = i.retire_reason ? ` (Grund: ${esc(i.retire_reason)})` : "";
        const retire = status !== "retired" ? ` <button type="button" data-retire="${esc(i.id)}">Stilllegen</button>` : "";
        return `<li><span class="role">${esc(i.role)}</span>${glob}: ${esc(i.text)}${reason}${retire}</li>`;
      })
      .join("");
    return `<section class="instincts-${status}"><h3>${esc(label)}</h3>${rows ? `<ul>${rows}</ul>` : "<p>Keine.</p>"}</section>`;
  }).join("");
  return `<section class="instincts"><h2>Instincts</h2>${groups}</section>`;
}

function ruleHtml(r: Rule): string {
  return `<li><code>${esc(r.id)}</code> ${esc(r.text)} <small>(${esc(r.source.path)}:${esc(r.source.lines.join("-"))})</small></li>`;
}

function constitutionHtml(c: Constitution | null): string {
  if (!c) return `<section class="constitution"><h2>Verfassung</h2><p>Keine CLAUDE.md im Projekt.</p></section>`;
  const parts = c.parts
    .map((p) => {
      const roles = p.roles === "all" ? "alle Rollen" : p.roles.join(", ");
      return `<h4>${esc(p.name)} <small>(${esc(roles)})</small></h4><ul>${p.rules.map(ruleHtml).join("")}</ul>`;
    })
    .join("");
  return (
    `<section class="constitution"><h2>Verfassung</h2>` +
    `<h3>Kern</h3><ul>${c.core.map(ruleHtml).join("")}</ul>` +
    `<h3>Teile</h3>${parts || "<p>Keine.</p>"}</section>`
  );
}

function adrsHtml(adrs: AdrInfo[]): string {
  const rows = adrs
    .map((a) => {
      const sup = a.supersededBy !== undefined ? ` durch ADR ${esc(a.supersededBy)}` : "";
      const open = a.openQuestions.length
        ? `<ul class="open-questions">${a.openQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`
        : "";
      return `<li>ADR ${esc(String(a.number).padStart(4, "0"))}: ${esc(a.title)} <span class="status">${esc(a.status)}${sup}</span>${open}</li>`;
    })
    .join("");
  return `<section class="adrs"><h2>ADRs</h2>${rows ? `<ul>${rows}</ul>` : "<p>Keine ADRs.</p>"}</section>`;
}

// Schreibende Aktionen ueber POST mit dem Token aus <meta name="usac-token">.
const SCRIPT = `<script>
function usacPost(url, body) {
  var t = document.querySelector('meta[name="usac-token"]');
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Usac-Token": t ? t.content : "" },
    body: JSON.stringify(body)
  }).then(function (r) { return r.text().then(function (x) { document.getElementById("knowledge-result").textContent = r.status + " " + x; }); });
}
document.querySelectorAll("button[data-verify]").forEach(function (b) {
  b.addEventListener("click", function () {
    var root = document.getElementById("verify-root");
    usacPost("/api/memory/" + encodeURIComponent(b.dataset.verify) + "/verify", { root: root ? root.value : "" });
  });
});
document.querySelectorAll("button[data-retire]").forEach(function (b) {
  b.addEventListener("click", function () {
    var reason = document.getElementById("retire-reason");
    usacPost("/api/instincts/" + b.dataset.retire + "/retire", { reason: reason ? reason.value : "" });
  });
});
</script>`;

/** Wissens-Seite: Memory, Instincts (nach Status), Verfassung, ADRs. Alle Werte escaped. */
export function knowledgeHtml(data: KnowledgeData, opts: { query?: string; token?: string; projectPath?: string } = {}): string {
  const parts: string[] = [`<h1>Wissen</h1>`];
  if (opts.token !== undefined) {
    parts.push(
      `<section class="knowledge-actions"><label>Projekt-Wurzel zum Verifizieren ` +
        `<input id="verify-root" type="text" value="${esc(opts.projectPath ?? "")}"></label> ` +
        `<label>Grund zum Stilllegen <input id="retire-reason" type="text"></label>` +
        `<p id="knowledge-result" role="status"></p></section>`,
    );
  }
  parts.push(memoryHtml(data.entries, opts.query ?? ""));
  parts.push(instinctsHtml(data.instincts));
  parts.push(constitutionHtml(data.constitution));
  parts.push(adrsHtml(data.adrs));
  if (opts.token !== undefined) parts.push(SCRIPT);
  return page("Wissen", parts.join(""), opts.token !== undefined ? { token: opts.token } : {});
}

/** GET /knowledge?q=… und /api/knowledge?q=…; das Token steht nur in der Seite, nie in der URL. */
export function registerKnowledge(app: Hono, deps: KnowledgeDeps, g?: Guard): void {
  app.get("/knowledge", (c) => {
    const query = c.req.query("q") ?? "";
    const opts: { query: string; token?: string; projectPath?: string } = { query };
    if (g) opts.token = g.token;
    if (deps.projectPath) opts.projectPath = deps.projectPath;
    return c.html(knowledgeHtml(knowledgeData(deps, query), opts));
  });
  app.get("/api/knowledge", (c) => c.json(knowledgeData(deps, c.req.query("q") ?? "")));
}
