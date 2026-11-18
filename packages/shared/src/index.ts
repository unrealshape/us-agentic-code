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

/** Fundstelle aus dem Graphify-Graph: Knoten plus pruefbare Quellstelle. */
export const GraphEvidence = z.object({
  type: z.literal("graph"),
  node_id: z.string().min(1),
  path: z.string().min(1),
  /** Zeilenbereich [start, end], 1-basiert, inklusive. */
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  /** Woertliches Zitat aus diesen Zeilen. */
  quote: z.string().min(1),
});
export type GraphEvidence = z.infer<typeof GraphEvidence>;
export type FileEvidence = z.infer<typeof FileEvidence>;

export const Evidence = z.discriminatedUnion("type", [
  FileEvidence,
  GateEvidence,
  UrlEvidence,
  UserEvidence,
  MemoryEvidence,
  GraphEvidence,
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
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;
export type AnalystOutput = z.infer<typeof AnalystOutput>;
export type Slice = z.infer<typeof Slice>;
export type TechLeadOutput = z.infer<typeof TechLeadOutput>;

export const ExplorerOutput = z.object({
  summary: z.string(),
  languages: z.array(z.string().min(1)).default([]),
  commands: z.object({
    build: z.string().optional(),
    test: z.string().optional(),
    lint: z.string().optional(),
    format: z.string().optional(),
  }),
  /** Konventionen sind Aussagen mit Stufe; ohne Datei-Beleg zaehlen sie nicht. */
  conventions: z.array(Claim).max(10).default([]),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});
export type ExplorerOutput = z.infer<typeof ExplorerOutput>;

export const InstinctProposal = z.object({
  text: z.string().min(1),
  role: z.string().min(1),
  glob: z.string().min(1).optional(),
  /** Ereignisse aus dem Event-Log, die den Vorschlag belegen. */
  event_ids: z.array(z.number().int().positive()).min(1),
});
export type InstinctProposal = z.infer<typeof InstinctProposal>;

export const MemoryProposal = z.object({
  kind: z.string().min(1),
  text: z.string().min(1),
  evidence: z.array(FileEvidence).min(1),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

export const LearnerOutput = z.object({
  summary: z.string(),
  instincts: z.array(InstinctProposal).max(3).default([]),
  memory: z.array(MemoryProposal).max(5).default([]),
  claims: z.array(Claim).default([]),
});
export type LearnerOutput = z.infer<typeof LearnerOutput>;

export const ArchitectOption = z.object({
  name: z.string().min(1),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});

export const AdrDraft = z.object({
  title: z.string().min(1),
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
});

/**
 * Architect schlaegt vor, entscheidet nicht: `decision` ist eine Empfehlung,
 * die Freigabe trifft der Mensch. Im Spike (Phase `research`) ohne `adr`,
 * Befunde in `claims`, Empfehlung in `decision`.
 */
export const ArchitectOutput = z.object({
  summary: z.string(),
  options: z.array(ArchitectOption).min(2),
  decision: z.string(),
  adr: AdrDraft.optional(),
  risks: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutput>;

export const QaOutput = z.object({
  summary: z.string(),
  /** Pfade der E2E-Tests unter den `test_globs` des Gate-Profils. */
  e2e_tests: z.array(z.string().min(1)).min(1),
  /** Abgedeckte Akzeptanzkriterien (AC-IDs). */
  criteria: z.array(z.string().regex(/^AC-\d+$/)).default([]),
  claims: z.array(Claim).default([]),
});
export type QaOutput = z.infer<typeof QaOutput>;

export const EnvironmentOutput = z.object({
  summary: z.string(),
  changed_files: z.array(z.string()).default([]),
  setup_commands: z.array(z.string()).default([]),
  claims: z.array(Claim).default([]),
  questions: z.array(z.string()).default([]),
});
export type EnvironmentOutput = z.infer<typeof EnvironmentOutput>;

export const ROLE_OUTPUTS = {
  architect: ArchitectOutput,
  "qa-engineer": QaOutput,
  "environment-engineer": EnvironmentOutput,
  analyst: AnalystOutput,
  "tech-lead": TechLeadOutput,
  "test-engineer": TestEngineerOutput,
  implementer: ImplementerOutput,
  "code-reviewer": ReviewerOutput,
  "security-reviewer": ReviewerOutput,
  explorer: ExplorerOutput,
  learner: LearnerOutput,
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

export type WorkItemType =
  | "bugfix"
  | "feature"
  | "change"
  | "refactor"
  | "new-project"
  | "dependency-update"
  | "security-fix"
  | "spike"
  | "onboarding";
export type WorkItemStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "escalated"
  | "failed";
