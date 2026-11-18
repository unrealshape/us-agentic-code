import { z } from "zod";
import { SizeSchema } from "@usac/shared";
import { loadYaml, type ProjectProfile } from "./config";
import type { WorkItem } from "./store";

/**
 * Bedingung einer Phase. Alle angegebenen Felder muessen zutreffen; ohne `when` laeuft die Phase immer.
 * - `size`: Phase nur bei diesen Groessen des Auftrags.
 * - `preview`: `true` nur mit, `false` nur ohne Preview im Projektprofil.
 */
export const PhaseCondition = z
  .object({
    size: z.array(SizeSchema).min(1).optional(),
    preview: z.boolean().optional(),
  })
  .strict();
export type PhaseCondition = z.infer<typeof PhaseCondition>;

export const PhaseSpec = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  variant: z.string().optional(),
  approval: z.string().optional(),
  until: z.array(z.string()).optional(),
  max_attempts: z.number().int().positive().optional(),
  expect: z.string().optional(),
  block_on: z.array(z.string()).optional(),
  when: PhaseCondition.optional(),
});
export type PhaseSpec = z.infer<typeof PhaseSpec>;

export const Workflow = z.object({
  name: z.string().min(1),
  phases: z.array(PhaseSpec).min(1),
  escalation: z.string().optional(),
});
export type Workflow = z.infer<typeof Workflow>;

export function loadWorkflow(path: string): Workflow {
  return Workflow.parse(loadYaml(path));
}

/** Prueft die Bedingung einer Phase; deterministisch, ohne LLM. */
export function phaseApplies(
  phase: PhaseSpec,
  wi: Pick<WorkItem, "size">,
  profile: Pick<ProjectProfile, "preview">,
): boolean {
  const when = phase.when;
  if (!when) return true;
  if (when.size && !when.size.includes(wi.size)) return false;
  if (when.preview !== undefined && when.preview !== (profile.preview !== undefined)) return false;
  return true;
}

/** Phasen des Workflows, deren Bedingung fuer Auftrag und Projekt zutrifft, in Workflow-Reihenfolge. */
export function activePhases(
  wf: Workflow,
  wi: Pick<WorkItem, "size">,
  profile: Pick<ProjectProfile, "preview">,
): PhaseSpec[] {
  return wf.phases.filter((p) => phaseApplies(p, wi, profile));
}
