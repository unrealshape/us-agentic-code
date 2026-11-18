import { z } from "zod";
import { loadYaml } from "./config";

export const PhaseSpec = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  variant: z.string().optional(),
  approval: z.string().optional(),
  until: z.array(z.string()).optional(),
  max_attempts: z.number().int().positive().optional(),
  expect: z.string().optional(),
  block_on: z.array(z.string()).optional(),
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
