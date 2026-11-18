import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AcceptanceCriterion, Slice } from "@usac/shared";
import type { GateResult } from "./store";

export type CriterionProof = {
  criterion: string;
  status: "proven" | "missing";
  tests: string[];
  gate_result_id?: number;
  reason?: string;
};

export type CriteriaEvidenceInput = {
  cwd: string;
  criteria: AcceptanceCriterion[];
  slices: Slice[];
  /** Gesperrte Testdateien je Slice-ID, relativ zu cwd. */
  sliceTests: Record<string, string[]>;
  /** Abnahme-Gate je Slice-ID. */
  sliceGates: Record<string, GateResult>;
};

function readText(cwd: string, file: string): string {
  try {
    return readFileSync(isAbsolute(file) ? file : join(cwd, file), "utf8");
  } catch {
    return "";
  }
}

/**
 * Gate-Stufe 6: Kriterium AC-n ist belegt, wenn ein Slice mit AC-n in `criteria`
 * einen gesperrten Testfile hat, dessen Text die Marke `[AC-n]` woertlich enthaelt,
 * und das Abnahme-Gate dieses Slices `passed` ist.
 */
export function criteriaEvidence(input: CriteriaEvidenceInput): CriterionProof[] {
  const cache = new Map<string, string>();
  const text = (file: string) => {
    let t = cache.get(file);
    if (t === undefined) {
      t = readText(input.cwd, file);
      cache.set(file, t);
    }
    return t;
  };

  return input.criteria.map((c): CriterionProof => {
    const marker = `[${c.id}]`;
    const covering = input.slices.filter((s) => s.criteria.includes(c.id));
    if (covering.length === 0) {
      return { criterion: c.id, status: "missing", tests: [], reason: `Kein Slice deckt ${c.id} ab` };
    }
    const reasons: string[] = [];
    const markedAll: string[] = [];
    for (const s of covering) {
      const files = input.sliceTests[s.id] ?? [];
      const marked = files.filter((f) => text(f).includes(marker));
      for (const f of marked) if (!markedAll.includes(f)) markedAll.push(f);
      if (marked.length === 0) {
        reasons.push(`${s.id}: Marke ${marker} in keinem gesperrten Test`);
        continue;
      }
      const gate = input.sliceGates[s.id];
      if (!gate) {
        reasons.push(`${s.id}: Gate fehlt`);
        continue;
      }
      if (gate.status !== "passed") {
        reasons.push(`${s.id}: Gate ${gate.name} ist ${gate.status}`);
        continue;
      }
      return { criterion: c.id, status: "proven", tests: marked, gate_result_id: gate.id };
    }
    return { criterion: c.id, status: "missing", tests: markedAll, reason: reasons.join("; ") };
  });
}
