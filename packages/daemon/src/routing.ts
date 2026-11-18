import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MODELS, type Model, type Size } from "@usac/shared";
import { loadYaml } from "./config";

const ModelName = z.enum(MODELS);

export const RoutingConfig = z.object({
  defaults: z.record(z.string(), z.union([ModelName, z.record(z.string(), ModelName)])),
  raise: z
    .object({
      size_large: z.array(z.string()).default([]),
      /** Nach so vielen Fehlversuchen eine Stufe hoeher. */
      after_failures: z.number().int().positive().default(2),
    })
    .default({}),
  fable: z
    .object({
      /** Nur diese Rollen duerfen Fable nutzen; sonst Deckel auf Opus. */
      only_roles: z.array(z.string()).default([]),
    })
    .default({}),
  budget: z
    .object({
      fable_needs_approval_above: z.number().min(0).max(1).default(0.75),
      only_sonnet_haiku_above: z.number().min(0).max(1).default(0.9),
      exempt: z.array(z.string()).default([]),
    })
    .default({}),
});
export type RoutingConfig = z.infer<typeof RoutingConfig>;

export interface RouteContext {
  size?: Size;
  /** Bisherige Fehlversuche dieser Rolle in diesem Auftrag. */
  failures?: number;
  /** Anteil des verbrauchten Kontingents, 0..1. */
  budgetUsed?: number;
  /** Untervariante der Rolle, z. B. "acceptance" beim Test Engineer. */
  variant?: string;
  /** Im Abo verfuegbare Modelle; fehlende werden nach unten ersetzt. */
  available?: Model[];
}

export interface Route {
  model: Model;
  reasons: string[];
  needsApproval: boolean;
}

const rank = (m: Model) => MODELS.indexOf(m);
const at = (i: number): Model => MODELS[Math.max(0, Math.min(MODELS.length - 1, i))]!;

/**
 * Lokale Abweichungen vom Plugin-Routing (`<home>/routing.override.yaml`, ADR 0010).
 * Schluessel in `defaults`: Rollenname oder `rolle.variante`. `trials` sind laufende Proben nach einer Herabstufung.
 */
export const RoutingOverride = z.object({
  defaults: z.record(z.string(), ModelName).default({}),
  trials: z
    .record(
      z.string(),
      z.object({ from: ModelName, to: ModelName, startedAt: z.string(), runs: z.number().int().min(0).default(0) }),
    )
    .default({}),
});
export type RoutingOverride = z.infer<typeof RoutingOverride>;

export function loadRoutingOverride(path: string): RoutingOverride {
  if (!existsSync(path)) return RoutingOverride.parse({});
  return RoutingOverride.parse(loadYaml(path) ?? {});
}

/**
 * Laedt `routing.yaml` aus dem Plugin. Eine Override-Datei ersetzt nur `defaults` der genannten Rollen
 * (bzw. Varianten); `raise`, `fable` und `budget` bleiben aus dem Plugin.
 */
export function loadRouting(pluginRoot: string, overridePath?: string): RoutingConfig {
  const cfg = RoutingConfig.parse(loadYaml(join(pluginRoot, "routing.yaml")));
  if (!overridePath) return cfg;
  const ov = loadRoutingOverride(overridePath);
  for (const [key, model] of Object.entries(ov.defaults)) {
    const dot = key.indexOf(".");
    if (dot < 0) {
      cfg.defaults[key] = model;
      continue;
    }
    const role = key.slice(0, dot);
    const variant = key.slice(dot + 1);
    const def = cfg.defaults[role];
    // Varianten-Override nur fuer Rollen, die im Plugin Varianten haben.
    if (def && typeof def === "object") def[variant] = model;
  }
  return cfg;
}

export function resolveModel(cfg: RoutingConfig, role: string, ctx: RouteContext = {}): Route {
  const reasons: string[] = [];
  const def = cfg.defaults[role];
  if (!def) throw new Error(`Rolle "${role}" hat keinen Eintrag in routing.yaml`);
  let base: Model;
  if (typeof def === "string") base = def;
  else {
    const v = ctx.variant && def[ctx.variant] ? ctx.variant : Object.keys(def)[0]!;
    base = def[v]!;
    reasons.push(`Variante ${v}`);
  }
  let i = rank(base);
  reasons.push(`Standard ${base}`);

  if (ctx.size === "large" && cfg.raise.size_large.includes(role)) {
    i += 1;
    reasons.push("Groesse large: +1 Stufe");
  }
  const steps = Math.floor((ctx.failures ?? 0) / cfg.raise.after_failures);
  if (steps > 0) {
    i += steps;
    reasons.push(`${ctx.failures} Fehlversuche: +${steps} Stufe(n)`);
  }

  let model = at(i);
  if (model === "fable" && !cfg.fable.only_roles.includes(role)) {
    model = "opus";
    reasons.push("Fable nur fuer Architekt: Deckel Opus");
  }
  let needsApproval = false;
  const used = ctx.budgetUsed ?? 0;
  const exempt = cfg.budget.exempt.includes(role);
  if (!exempt && used >= cfg.budget.only_sonnet_haiku_above && rank(model) > rank("sonnet")) {
    model = "sonnet";
    reasons.push(`Kontingent ${Math.round(used * 100)} %: hoechstens Sonnet`);
  } else if (!exempt && used >= cfg.budget.fable_needs_approval_above && model === "fable") {
    needsApproval = true;
    reasons.push(`Kontingent ${Math.round(used * 100)} %: Fable braucht Freigabe`);
  }

  if (ctx.available && ctx.available.length) {
    while (!ctx.available.includes(model) && rank(model) > 0) {
      const lower = at(rank(model) - 1);
      reasons.push(`${model} nicht verfuegbar: ${lower}`);
      model = lower;
    }
  }
  return { model, reasons, needsApproval };
}
