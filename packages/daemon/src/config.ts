import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WorkItemType } from "@usac/shared";
import { parseProtectorMode } from "./hook-log";
import { PreviewConfig } from "./preview";
import { TestDbConfig } from "./testdb";

export { parseProtectorMode, type ProtectorMode } from "./hook-log";

export const ProjectProfile = z.object({
  name: z.string(),
  languages: z.array(z.string()).default([]),
  gate_profile: z.string(),
  base_branch: z.string().default("main"),
  // Tippfehler im Modus fuehren zu `blockieren`, nicht zu einem Parse-Fehler.
  protector: z
    .object({ mode: z.unknown().transform(parseProtectorMode) })
    .default({ mode: "blockieren" }),
  gateguard: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  network: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
  /** Projektbefehle aus dem Onboarding (vom Nutzer bestaetigt). */
  commands: z
    .object({ build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), format: z.string().optional() })
    .optional(),
  /** Zeitpunkt der Bestaetigung im Onboarding (ISO 8601). */
  confirmed_at: z.string().optional(),
  adr: z
    .object({ dir: z.string().default("docs/adr"), require_for_dependencies: z.boolean().default(true) })
    .default({ dir: "docs/adr", require_for_dependencies: true }),
  /** Lokale Preview je Aufgabe (Phase 4). */
  preview: PreviewConfig.optional(),
  /** Eigene Test-Datenbank je Aufgabe (Phase 4). */
  test_db: TestDbConfig.optional(),
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;
/** Profilvorschlag des Onboardings: Profil plus Konventionen (nur Texte, Belege liegen im Auftrag). */
export type ProfileProposal = ProjectProfile & { conventions: string[] };

/** Alle Work-Item-Typen; muss zu `WorkItemType` in @usac/shared passen (siehe Typpruefung unten). */
const WORK_ITEM_TYPES = [
  "bugfix",
  "feature",
  "change",
  "refactor",
  "new-project",
  "dependency-update",
  "security-fix",
  "spike",
  "onboarding",
] as const satisfies readonly WorkItemType[];
type _AllTypesCovered = WorkItemType extends (typeof WORK_ITEM_TYPES)[number] ? true : never;
const _allTypesCovered: _AllTypesCovered = true;
void _allTypesCovered;

export const GateStage = z
  .object({
    name: z.string(),
    /** Shell-Befehl; `{base}` wird durch den Basis-Commit ersetzt. Bei internen Gates entbehrlich. */
    run: z.string().optional(),
    /** Internes Gate (Stufe 5/6) statt Shell-Befehl. */
    internal: z.enum(["coverage_diff", "criteria_evidence"]).optional(),
    stage: z.number().int().min(1).max(6).default(1),
    optional: z.boolean().default(false),
    /** Work-Item-Typen, in denen ein fehlendes Werkzeug (Exit 127) das Gate scheitern laesst. */
    required_in: z.array(z.enum(WORK_ITEM_TYPES)).default([]),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .refine((s) => s.run !== undefined || s.internal !== undefined, { message: "Gate braucht `run` oder `internal`" });
export type GateStage = z.infer<typeof GateStage>;

export const GateProfile = z.object({
  name: z.string(),
  detect: z.array(z.string()).default([]),
  test_globs: z.array(z.string()).default([]),
  protected_globs: z.array(z.string()).default([]),
  skip_markers: z.array(z.string()).default([]),
  network_allow: z.array(z.string()).default([]),
  acceptance: z.object({
    run: z.string(),
    timeout_ms: z.number().int().positive().default(120_000),
    /** Regex-Muster: trifft eines auf die Ausgabe eines roten Abnahmetests, ist es ein Build- statt Testfehler. */
    build_error_patterns: z.array(z.string()).default([]),
  }),
  stages: z.array(GateStage),
  /** Geteilte Stufen aus `gate-profiles/_shared/<name>.yaml`, werden an `stages` angehaengt. */
  includes: z.array(z.string().regex(/^[\w-]+$/)).default([]),
  /** Eingaben des internen Gates `coverage_diff` (lcov-Pfad relativ zum Projekt). */
  coverage: z
    .object({ lcov: z.string(), include: z.array(z.string()).min(1), threshold: z.number().min(0).max(1) })
    .optional(),
});
const SharedStages = z.object({ stages: z.array(GateStage) });
type ParsedGateProfile = z.infer<typeof GateProfile>;
/** `includes` ist nach dem Laden immer gesetzt; von Hand gebaute Profile duerfen es weglassen. */
export type GateProfile = Omit<ParsedGateProfile, "includes"> & Partial<Pick<ParsedGateProfile, "includes">>;

export function loadYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

export function loadProjectProfile(projectPath: string): ProjectProfile {
  const p = join(projectPath, ".usac/project.yaml");
  if (!existsSync(p)) {
    throw new Error(`Kein Projektprofil gefunden: ${p}. Erst "usac init" ausfuehren.`);
  }
  return ProjectProfile.parse(loadYaml(p));
}

export function loadGateProfile(pluginRoot: string, name: string): GateProfile {
  const p = join(pluginRoot, "gate-profiles", `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`Gate-Profil "${name}" fehlt: ${p}`);
  const profile = GateProfile.parse(loadYaml(p));
  for (const inc of profile.includes) {
    const sp = join(pluginRoot, "gate-profiles", "_shared", `${inc}.yaml`);
    if (!existsSync(sp)) throw new Error(`Geteilte Gate-Stufen "${inc}" fehlen: ${sp} (eingebunden von "${name}")`);
    profile.stages.push(...SharedStages.parse(loadYaml(sp)).stages);
  }
  return profile;
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => new Bun.Glob(g).match(path));
}
