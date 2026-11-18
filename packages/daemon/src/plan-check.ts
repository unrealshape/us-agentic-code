import type { Slice, TechLeadOutput } from "@usac/shared";
import { type GateProfile, matchesAny } from "./config";

function normalizePath(p: string): string {
  let n = p.split(String.fromCharCode(92)).join("/");
  while (n.startsWith("./")) n = n.slice(2);
  return n;
}

function findCycle(slices: Slice[]): string[] | null {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const st = state.get(id);
    if (st === 2) return null;
    if (st === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const s of slices) {
    const c = visit(s.id);
    if (c) return c;
  }
  return null;
}

export function checkPlan(
  criteriaIds: string[],
  plan: TechLeadOutput,
  gp: GateProfile,
): { errors: string[]; plan: TechLeadOutput } {
  const errors: string[] = [];
  const known = new Set(criteriaIds);
  const ids = new Set<string>();
  const covered = new Set<string>();
  for (const s of plan.slices) {
    if (ids.has(s.id)) errors.push(`Doppelte Slice-ID ${s.id}`);
    ids.add(s.id);
  }
  const slices = plan.slices.map((s) => {
    for (const c of s.criteria) {
      if (known.has(c)) covered.add(c);
      else errors.push(`${s.id} verweist auf unbekanntes Kriterium ${c}`);
    }
    for (const d of s.depends_on) {
      if (!ids.has(d)) errors.push(`${s.id} hängt von unbekanntem Slice ${d} ab`);
    }
    const files = s.files.map((f) => {
      const n = normalizePath(f);
      if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) errors.push(`${s.id}: absoluter Pfad ${n}`);
      else if (n.split("/").includes("..")) errors.push(`${s.id}: Pfad außerhalb des Projekts ${n}`);
      else if (matchesAny(n, gp.protected_globs)) errors.push(`${s.id}: geschützte Datei ${n}`);
      return n;
    });
    return { ...s, files };
  });
  for (const c of criteriaIds) {
    if (!covered.has(c)) errors.push(`${c} ist keinem Slice zugeordnet`);
  }
  const cycle = findCycle(slices);
  if (cycle) errors.push(`Zyklus: ${cycle.join(" -> ")}`);
  return { errors, plan: { ...plan, slices } };
}

export function sliceOrder(slices: Slice[]): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  const ids = new Set(slices.map((s) => s.id));
  while (order.length < slices.length) {
    const next = slices.find(
      (s) => !done.has(s.id) && s.depends_on.every((d) => done.has(d) || !ids.has(d)),
    );
    if (!next) break;
    done.add(next.id);
    order.push(next.id);
  }
  return order;
}
