import type { z } from "zod";
import type { Model, ROLE_OUTPUTS, RoleWithOutput } from "@usac/shared";
import type { GateProfile, ProjectProfile } from "./config";
import type { RoutingConfig } from "./routing";
import type { Runner } from "./runner/types";
import type { Store, WorkItem } from "./store";
import type { PhaseSpec, Workflow } from "./workflow";

/** Fehler, der den Auftrag eskaliert (statt "failed"). */
export class Escalate extends Error {}

export interface PhaseLimits {
  acceptanceAttempts: number;
  implementAttempts: number;
  reviewAttempts: number;
  maxTurns: number;
  runTimeoutMs: number;
}

export type Actor = `role:${string}` | "orchestrator";

/**
 * Was ein Phasen-Handler vom Orchestrator bekommt.
 *
 * Vertrag fuer den Rueckgabewert:
 * - `state.phase` unveraendert  -> der Orchestrator geht zur naechsten Phase der Workflow-Datei.
 * - `state.phase` geaendert     -> Sprung zu dieser Phase (z. B. review -> implement).
 * - `status: "awaiting_approval"` -> Lauf pausiert; beim naechsten `run` wird dieselbe Phase erneut aufgerufen.
 * - `status: "done"`            -> Lauf endet.
 */
export interface PhaseContext {
  spec: PhaseSpec;
  workflow: Workflow;
  store: Store;
  runner: Runner;
  pluginRoot: string;
  home: string;
  profile: ProjectProfile;
  gateProfile: GateProfile;
  limits: PhaseLimits;
  routing: RoutingConfig;
  autoApprovals: ReadonlySet<string>;
  available?: Model[];
  graphify?: boolean;
  urlAllowlist?: string[];
  /** Anteil des verbrauchten Kontingents (0..1) fuer resolveModel. */
  budgetUsed(): number;
  emit(wi: WorkItem, type: string, data?: unknown, spanId?: string, actor?: Actor): unknown;
  state(wi: WorkItem): Record<string, unknown> & { phase: string };
  save(wi: WorkItem, patch: Record<string, unknown>, extra?: Partial<Pick<WorkItem, "status" | "branch" | "worktree">>): WorkItem;
  runRole: RunRole;
  commit(cwd: string, message: string): Promise<string>;
}

/** Zusatzoptionen einer Session: gesperrte Werkzeuge und zusaetzliche Umgebung (ausgewertet ab Task 9). */
export type RunRoleOptions = { disallowedTools?: string[]; env?: Record<string, string>; slice?: string };

/** Startet eine Rolle, validiert Schema und Belege. Ungueltige Ausgaben gelten als Fehlversuch. */
export type RunRole = <R extends RoleWithOutput>(
  wi: WorkItem,
  role: R,
  model: Model,
  prompt: string,
  opts?: RunRoleOptions,
) => Promise<{ ok: true; output: z.infer<(typeof ROLE_OUTPUTS)[R]> } | { ok: false; feedback: string }>;

export type PhaseHandler = (wi: WorkItem, ctx: PhaseContext) => Promise<WorkItem>;

const registry = new Map<string, PhaseHandler>();

/** Registriert (oder ersetzt) den Handler fuer eine Phase. */
export function registerPhase(name: string, handler: PhaseHandler): void {
  registry.set(name, handler);
}

export function getPhase(name: string): PhaseHandler | undefined {
  return registry.get(name);
}

/** Momentaufnahme der Registry, z. B. fuer Tests (beforeEach/afterEach). */
export type PhaseSnapshot = ReadonlyMap<string, PhaseHandler>;

export function snapshotPhases(): PhaseSnapshot {
  return new Map(registry);
}

/** Stellt die Registry exakt auf eine Momentaufnahme zurueck (spaeter registrierte Handler fallen weg). */
export function restorePhases(snapshot: PhaseSnapshot): void {
  registry.clear();
  for (const [name, handler] of snapshot) registry.set(name, handler);
}

/** Namen aus dem Workflow, fuer die kein Handler registriert ist. */
export function missingPhases(workflow: Workflow): string[] {
  return workflow.phases.map((p) => p.name).filter((n) => !registry.has(n));
}
