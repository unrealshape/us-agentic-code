import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Claim, Evidence } from "@usac/shared";
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
}

export interface EvidenceError {
  claim: string;
  problem: string;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export function checkEvidence(ev: Evidence, ctx: EvidenceContext): string | null {
  switch (ev.type) {
    case "file": {
      if (isAbsolute(ev.path) || ev.path.split(/[\\/]/).includes("..")) return `Pfad ${ev.path} liegt ausserhalb des Projekts`;
      const full = join(ctx.cwd, ev.path);
      if (!existsSync(full)) return `Datei ${ev.path} existiert nicht`;
      const rel = relative(realpathSync(ctx.cwd), realpathSync(full));
      if (rel.startsWith("..")) return `Pfad ${ev.path} liegt ausserhalb des Projekts`;
      const lines = readFileSync(full, "utf8").split("\n");
      const [start, end] = ev.lines;
      if (start > end) return `Zeilenbereich ${start}-${end} ist ungueltig`;
      if (end > lines.length) return `${ev.path} hat nur ${lines.length} Zeilen, Beleg nennt ${start}-${end}`;
      const excerpt = normalize(lines.slice(start - 1, end).join("\n"));
      if (!excerpt.includes(normalize(ev.quote))) {
        return `Zitat steht nicht in ${ev.path}:${start}-${end} (dort steht: "${excerpt.slice(0, 120)}")`;
      }
      return null;
    }
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
    case "memory":
      return "Memory-Belege sind in Phase 0 noch nicht verfuegbar";
    case "graph":
      // Echte Pruefung folgt in Phase 3, Task 2 (graph.ts); bis dahin gilt ein Graph-Beleg als ungueltig.
      return "Graph-Belege sind noch nicht pruefbar";
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
