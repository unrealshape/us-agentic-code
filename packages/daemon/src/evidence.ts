import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Claim, Evidence } from "@usac/shared";
import { loadGraph } from "./graph";
import type { Store } from "./store";

/**
 * Belegpruefung: Jede Aussage der Stufe VERIFIED oder EXTRACTED braucht mindestens
 * einen Beleg, und jeder angegebene Beleg muss mechanisch pruefbar stimmen.
 */
export interface EvidenceContext {
  cwd: string;
  store: Store;
  workItemId: string;
  urlAllowlist?: string[];
  /** Prueft einen Memory-Beleg; Rueckgabe `null` = gueltig, sonst Fehlermeldung. */
  memory?: { check(id: string, cwd: string): string | null };
}

export interface EvidenceError {
  claim: string;
  problem: string;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Prueft, dass `quote` in `path` (relativ zu `cwd`) in den Zeilen `lines` steht. */
function checkQuote(cwd: string, path: string, lines: [number, number], quote: string): string | null {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return `Pfad ${path} liegt ausserhalb des Projekts`;
  const full = join(cwd, path);
  if (!existsSync(full)) return `Datei ${path} existiert nicht`;
  const rel = relative(realpathSync(cwd), realpathSync(full));
  if (rel.startsWith("..")) return `Pfad ${path} liegt ausserhalb des Projekts`;
  const content = readFileSync(full, "utf8").split("\n");
  const [start, end] = lines;
  if (start > end) return `Zeilenbereich ${start}-${end} ist ungueltig`;
  if (end > content.length) return `${path} hat nur ${content.length} Zeilen, Beleg nennt ${start}-${end}`;
  const excerpt = normalize(content.slice(start - 1, end).join("\n"));
  if (!excerpt.includes(normalize(quote))) {
    return `Zitat steht nicht in ${path}:${start}-${end} (dort steht: "${excerpt.slice(0, 120)}")`;
  }
  return null;
}

export function checkEvidence(ev: Evidence, ctx: EvidenceContext): string | null {
  switch (ev.type) {
    case "file":
      return checkQuote(ctx.cwd, ev.path, ev.lines, ev.quote);
    case "gate": {
      const g = ctx.store.getGate(ev.gate_result_id);
      if (!g || g.workItemId !== ctx.workItemId) return `Gate-Ergebnis ${ev.gate_result_id} existiert nicht fuer diesen Auftrag`;
      return null;
    }
    case "url": {
      const host = new URL(ev.url).hostname;
      const allow = ctx.urlAllowlist ?? [];
      if (!allow.some((a) => host === a || host.endsWith(`.${a}`))) return `URL-Host ${host} steht nicht auf der Allowlist`;
      return null;
    }
    case "user": {
      const a = ctx.store.getApproval(ev.approval_id);
      if (!a || a.status !== "granted") return `Freigabe ${ev.approval_id} existiert nicht oder ist nicht erteilt`;
      return null;
    }
    case "memory": {
      if (!ctx.memory) return `Memory-Beleg ${ev.id}: Memory nicht verfügbar`;
      const problem = ctx.memory.check(ev.id, ctx.cwd);
      return problem ? `Memory-Beleg ${ev.id} ist ungueltig: ${problem}` : null;
    }
    case "graph": {
      const nodes = loadGraph(ctx.cwd);
      if (!nodes) return `Graph-Beleg ${ev.node_id}: kein Graph (graphify-out/graph.json fehlt oder ist unlesbar)`;
      const node = nodes.find((n) => n.id === ev.node_id);
      if (!node) return `Knoten ${ev.node_id} steht nicht im Graph`;
      if (node.path !== ev.path.replace(/\\/g, "/")) return `Knoten ${ev.node_id} gehoert zu ${node.path}, Beleg nennt ${ev.path}`;
      return checkQuote(ctx.cwd, ev.path, ev.lines, ev.quote);
    }
  }
}

export function validateClaims(claims: Claim[], ctx: EvidenceContext): EvidenceError[] {
  const errors: EvidenceError[] = [];
  for (const c of claims) {
    if ((c.level === "VERIFIED" || c.level === "EXTRACTED") && c.evidence.length === 0) {
      errors.push({ claim: c.text, problem: `Stufe ${c.level} ohne Beleg` });
    }
    for (const ev of c.evidence) {
      const problem = checkEvidence(ev, ctx);
      if (problem) errors.push({ claim: c.text, problem });
    }
  }
  return errors;
}

export function validateFindings(
  findings: { severity: string; text: string; evidence: Evidence[] }[],
  ctx: EvidenceContext,
): EvidenceError[] {
  const errors: EvidenceError[] = [];
  for (const f of findings) {
    if ((f.severity === "critical" || f.severity === "high") && f.evidence.length === 0) {
      errors.push({ claim: f.text, problem: `Befund "${f.severity}" ohne Beleg` });
    }
    for (const ev of f.evidence) {
      const problem = checkEvidence(ev, ctx);
      if (problem) errors.push({ claim: f.text, problem });
    }
  }
  return errors;
}

const HEDGES = [
  "sollte jetzt",
  "sollte funktionieren",
  "wahrscheinlich",
  "vermutlich",
  "ich denke",
  "ich glaube",
  "should work",
  "should now",
  "probably",
  "i think",
  "i believe",
  "likely works",
];

/** Findet Vermutungswoerter in einem Abschlusstext (fuer das Delivery-Gate). */
export function findHedges(text: string): string[] {
  const lower = text.toLowerCase();
  return HEDGES.filter((h) => lower.includes(h));
}
