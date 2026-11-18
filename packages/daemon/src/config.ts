import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseProtectorMode } from "./hook-log";

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
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;
/** Profilvorschlag des Onboardings: Profil plus Konventionen (nur Texte, Belege liegen im Auftrag). */
export type ProfileProposal = ProjectProfile & { conventions: string[] };

export const GateStage = z.object({
  name: z.string(),
  run: z.string(),
  stage: z.number().int().min(1).max(6).default(1),
  optional: z.boolean().default(false),
  timeout_ms: z.number().int().positive().default(120_000),
});
export type GateStage = z.infer<typeof GateStage>;

export const GateProfile = z.object({
  name: z.string(),
  detect: z.array(z.string()).default([]),
  test_globs: z.array(z.string()).default([]),
  protected_globs: z.array(z.string()).default([]),
  skip_markers: z.array(z.string()).default([]),
  network_allow: z.array(z.string()).default([]),
  acceptance: z.object({ run: z.string(), timeout_ms: z.number().int().positive().default(120_000) }),
  stages: z.array(GateStage),
});
export type GateProfile = z.infer<typeof GateProfile>;

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
  return GateProfile.parse(loadYaml(p));
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => new Bun.Glob(g).match(path));
}
