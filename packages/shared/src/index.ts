import { z } from "zod";

// ---------------------------------------------------------------------------
// Belege und Aussagen (Belegpflicht: kein Raten)
// ---------------------------------------------------------------------------

export const FileEvidence = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
  /** Zeilenbereich [start, end], 1-basiert, inklusive. */
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  /** Woertliches Zitat aus diesen Zeilen. */
  quote: z.string().min(1),
});

export const GateEvidence = z.object({
  type: z.literal("gate"),
  /** ID eines Gate-Ergebnisses aus dem Event-Log. */
  gate_result_id: z.number().int().positive(),
});

export const UrlEvidence = z.object({
  type: z.literal("url"),
  url: z.string().url(),
});

export const UserEvidence = z.object({
  type: z.literal("user"),
  approval_id: z.number().int().positive(),
});

export const MemoryEvidence = z.object({
  type: z.literal("memory"),
  id: z.string().min(1),
});

export const Evidence = z.discriminatedUnion("type", [
  FileEvidence,
  GateEvidence,
  UrlEvidence,
  UserEvidence,
  MemoryEvidence,
]);
export type Evidence = z.infer<typeof Evidence>;

export const Level = z.enum(["VERIFIED", "EXTRACTED", "INFERRED", "UNKNOWN"]);
export type Level = z.infer<typeof Level>;

export const Claim = z.object({
  text: z.string().min(1),
  level: Level,
  evidence: z.array(Evidence).default([]),
});
export type Claim = z.infer<typeof Claim>;

// ---------------------------------------------------------------------------
// Ausgaben der Rollen
// ---------------------------------------------------------------------------

export const TestEngineerOutput = z.object({
  summary: z.string(),
  acceptance_tests: z.array(z.string().min(1)).min(1),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});

export const ImplementerOutput = z.object({
  summary: z.string(),
  changed_files: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});

export const Severity = z.enum(["critical", "high", "medium", "low"]);

export const Finding = z.object({
  severity: Severity,
  text: z.string().min(1),
  evidence: z.array(Evidence).default([]),
});

export const ReviewerOutput = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: z.string(),
  findings: z.array(Finding).default([]),
  claims: z.array(Claim).default([]),
});

export const SizeSchema = z.enum(["trivial", "small", "standard", "large"]);
export type Size = z.infer<typeof SizeSchema>;

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d+$/),
  given: z.string(),
  when: z.string(),
  then: z.string(),
  source: z.enum(["task", "code", "user"]),
});

export const AnalystOutput = z.object({
  summary: z.string(),
  title: z.string(),
  criteria: z.array(AcceptanceCriterion).min(1),
  out_of_scope: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});

export const Slice = z.object({
  id: z.string().regex(/^S\d+$/),
  title: z.string(),
  criteria: z.array(z.string()).min(1),
  files: z.array(z.string()).min(1),
  depends_on: z.array(z.string()).default([]),
});

export const TechLeadOutput = z.object({
  summary: z.string(),
  size: SizeSchema,
  slices: z.array(Slice).min(1).max(8),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});
export type Slice = z.infer<typeof Slice>;
export type TechLeadOutput = z.infer<typeof TechLeadOutput>;

export const ROLE_OUTPUTS = {
  analyst: AnalystOutput,
  "tech-lead": TechLeadOutput,
  "test-engineer": TestEngineerOutput,
  implementer: ImplementerOutput,
  "code-reviewer": ReviewerOutput,
  "security-reviewer": ReviewerOutput,
} as const;

export type RoleWithOutput = keyof typeof ROLE_OUTPUTS;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type Actor = "orchestrator" | "user" | `role:${string}`;

export interface UsacEvent<T = unknown> {
  id: number;
  ts: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  project: string;
  type: string;
  actor: Actor;
  data: T;
}

export const MODELS = ["haiku", "sonnet", "opus", "fable"] as const;
export type Model = (typeof MODELS)[number];

export type WorkItemType = "bugfix" | "feature" | "change" | "refactor";
export type WorkItemStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "escalated"
  | "failed";
