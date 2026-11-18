import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "@usac/shared";
import { checkEvidence, type EvidenceContext } from "./evidence";
import { git } from "./exec";
import { findNodes, loadGraph } from "./graph";
import { checkMemoryEvidence, search } from "./memory";
import type { Store } from "./store";

/**
 * Wissensluecken-Pipeline: Eine offene Frage wird in fester Reihenfolge an Quellen gestellt
 * (Memory, Graph, Code, Doku), erst danach wird der Nutzer gefragt. Deterministisch, ohne LLM.
 * Es zaehlen nur Treffer, deren Beleg `checkEvidence` besteht.
 */
export const GAP_ORDER = ["memory", "graph", "code", "docs", "user"] as const;
export type GapSource = (typeof GAP_ORDER)[number];
export const MAX_HITS = 5;
export const DOC_GLOBS = ["docs/**", "**/*.md", "**/*.rst", "README*"];

export type Hit = { source: GapSource; text: string; evidence: Evidence };
export type GapContext = { cwd: string; store: Store; memory: Database; workItemId: string; emit(type: string, data: unknown): void };
export type GapResult = { source: Exclude<GapSource, "user">; hits: Hit[] } | { source: "user"; approvalId: number };

const MAX_KEYWORDS = 6;
const MIN_KEYWORD_LEN = 4;
// Nur Woerter ab 4 Zeichen sind relevant, kuerzere fallen ohnehin weg.
const STOPWORDS = new Set([
  // de
  "aber", "alle", "allem", "allen", "aller", "alles", "also", "andere", "anderen", "auch", "auf", "bitte", "damit", "dann",
  "darf", "darum", "dass", "dein", "deine", "denn", "dessen", "dich", "dies", "diese", "diesem", "diesen", "dieser",
  "dieses", "doch", "dort", "durch", "eine", "einem", "einen", "einer", "eines", "etwa", "etwas", "euch", "habe", "haben",
  "hast", "hatte", "hier", "ihnen", "ihre", "ihrem", "ihren", "ihrer", "immer", "jede", "jedem", "jeden", "jeder", "jedes",
  "jene", "kann", "kein", "keine", "keinen", "keiner", "können", "könnte", "machen", "macht", "mehr", "mein", "meine",
  "muss", "müssen", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sein", "seine", "seinem", "seinen", "seiner",
  "selbst", "sich", "sind", "soll", "sollte", "sondern", "über", "unter", "viel", "vom", "von", "warum", "weil", "welche",
  "welchem", "welchen", "welcher", "welches", "wenn", "werde", "werden", "wieso", "wird", "wurde", "wurden", "zwischen",
  "heißt", "gibt", "steht", "geht", "eigentlich", "genau", "wofür", "wozu", "womit", "wodurch", "woher", "wohin",
  // en
  "about", "above", "after", "again", "also", "because", "been", "before", "being", "below", "both", "could", "does",
  "doing", "down", "during", "each", "from", "further", "have", "having", "here", "into", "just", "more", "most", "much",
  "must", "only", "other", "ought", "over", "same", "shall", "should", "some", "such", "than", "that", "their", "theirs",
  "them", "then", "there", "these", "they", "this", "those", "through", "under", "until", "very", "want", "were", "what",
  "when", "where", "which", "while", "whom", "whose", "will", "with", "would", "your", "yours", "please", "make", "makes",
]);

/** Schluesselwoerter: klein, ab 4 Zeichen, ohne Stoppwoerter (de/en), nur `[\p{L}\p{N}_]`, hoechstens 6, ohne Dubletten. */
export function keywords(question: string): string[] {
  const out: string[] = [];
  for (const w of question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if ([...w].length < MIN_KEYWORD_LEN || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/** Mindestzahl Schluesselwoerter je Treffer. */
const needed = (kws: string[]) => Math.min(2, kws.length);
const countIn = (text: string, kws: string[]) => {
  const t = text.toLowerCase();
  return kws.filter((k) => t.includes(k)).length;
};

function evidenceContext(ctx: GapContext): EvidenceContext {
  return {
    cwd: ctx.cwd,
    store: ctx.store,
    workItemId: ctx.workItemId,
    memory: { check: (id, cwd) => checkMemoryEvidence(ctx.memory, id, cwd) },
  };
}

class Unavailable extends Error {}

function searchMemory(ctx: GapContext, kws: string[]): Hit[] {
  const score = new Map<string, { text: string; n: number; order: number }>();
  for (const k of kws) {
    for (const e of search(ctx.memory, k)) {
      if (e.status !== "verified" || !e.uid) continue;
      const cur = score.get(e.uid) ?? { text: e.text, n: 0, order: score.size };
      cur.n++;
      score.set(e.uid, cur);
    }
  }
  return [...score.entries()]
    .filter(([, v]) => v.n >= needed(kws))
    .sort((a, b) => b[1].n - a[1].n || a[1].order - b[1].order)
    .map(([uid, v]): Hit => ({ source: "memory", text: v.text, evidence: { type: "memory", id: uid } }));
}

function readLines(cwd: string, path: string): string[] | null {
  let buf: Buffer;
  try {
    buf = readFileSync(join(cwd, path));
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // Binaerdatei
  return buf.toString("utf8").split("\n").map((l) => l.replace(/\r$/, ""));
}

function searchGraph(ctx: GapContext, kws: string[]): Hit[] {
  const nodes = loadGraph(ctx.cwd);
  if (!nodes) throw new Unavailable("graphify-out/graph.json fehlt oder ist unlesbar");
  const hits: Hit[] = [];
  for (const n of findNodes(nodes, kws)) {
    if (!n.line) continue;
    const quote = readLines(ctx.cwd, n.path)?.[n.line - 1]?.trim();
    if (!quote) continue;
    hits.push({ source: "graph", text: `${n.label} (${n.path}:${n.line})`, evidence: { type: "graph", node_id: n.id, path: n.path, lines: [n.line, n.line], quote } });
  }
  return hits;
}

async function trackedFiles(cwd: string): Promise<{ code: string[]; docs: string[] }> {
  let out: string;
  try {
    out = await git(cwd, "ls-files", "-z");
  } catch (err) {
    throw new Unavailable(`git ls-files fehlgeschlagen: ${(err as Error).message}`);
  }
  const globs = DOC_GLOBS.map((g) => new Bun.Glob(g));
  const code: string[] = [];
  const docs: string[] = [];
  for (const f of out.split("\0").filter(Boolean)) {
    if (globs.some((g) => g.match(f))) docs.push(f);
    else if (!f.startsWith("graphify-out/")) code.push(f);
  }
  return { code, docs };
}

function searchFiles(ctx: GapContext, source: "code" | "docs", files: string[], kws: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const path of files) {
    const lines = readLines(ctx.cwd, path);
    if (!lines) continue;
    lines.forEach((line, i) => {
      const quote = line.trim();
      if (!quote || countIn(line, kws) < needed(kws)) return;
      hits.push({ source, text: `${path}:${i + 1}: ${quote}`, evidence: { type: "file", path, lines: [i + 1, i + 1], quote } });
    });
    // Mehr als noetig nicht sammeln: geprueft wird spaeter, Reserve fuer ungueltige Belege.
    if (hits.length >= MAX_HITS * 4) break;
  }
  return hits;
}

/**
 * Schliesst eine Wissensluecke: fragt die Quellen in `GAP_ORDER` ab (nach `after`, falls angegeben)
 * und liefert die erste Quelle mit gueltig belegten Treffern (hoechstens `MAX_HITS`).
 * Ohne Treffer wird eine Freigabe `question` angelegt.
 */
export async function resolveGap(question: string, ctx: GapContext, after?: GapSource): Promise<GapResult> {
  const kws = keywords(question);
  const start = after ? GAP_ORDER.indexOf(after) + 1 : 0;
  const sources = GAP_ORDER.slice(start).filter((s): s is Exclude<GapSource, "user"> => s !== "user");
  const evCtx = evidenceContext(ctx);
  const searched: GapSource[] = [];
  let files: Promise<{ code: string[]; docs: string[] }> | null = null;

  for (const source of sources) {
    searched.push(source);
    let raw: Hit[];
    try {
      if (kws.length === 0) raw = [];
      else if (source === "memory") raw = searchMemory(ctx, kws);
      else if (source === "graph") raw = searchGraph(ctx, kws);
      else {
        files ??= trackedFiles(ctx.cwd);
        raw = searchFiles(ctx, source, (await files)[source], kws);
      }
    } catch (err) {
      if (!(err instanceof Unavailable)) throw err;
      ctx.emit("gap.source_unavailable", { source, reason: err.message });
      continue;
    }
    const hits = raw.filter((h) => checkEvidence(h.evidence, evCtx) === null).slice(0, MAX_HITS);
    ctx.emit("gap.searched", { question, source, hits: hits.length });
    if (hits.length > 0) {
      ctx.emit("gap.resolved", { question, source });
      return { source, hits };
    }
  }

  const approval = ctx.store.createApproval(ctx.workItemId, "question", { question, searched });
  ctx.emit("gap.asked_user", { question, approval_id: approval.id });
  return { source: "user", approvalId: approval.id };
}

/** Treffer als Text fuer einen Prompt: Frage, Quelle, je Treffer Inhalt und Beleg. */
export function formatHits(question: string, hits: Hit[]): string {
  if (hits.length === 0) return `Frage: ${question}\nKeine belegten Treffer.`;
  const lines = [`Frage: ${question}`, `Gefunden in: ${hits[0]!.source}`];
  for (const h of hits) lines.push(`- ${h.text}`, `  Beleg: ${JSON.stringify(h.evidence)}`);
  return lines.join("\n");
}
