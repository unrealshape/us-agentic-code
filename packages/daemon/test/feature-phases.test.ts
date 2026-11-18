/**
 * Handler spec, approve_spec und plan des Feature-Workflows (Phase 1b, Task 4).
 * Lauf ueber einen eigenen Plugin-Ordner, dessen feature.yaml nach plan endet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, REPO_ROOT, setupProject, tempHome } from "../../../tests/helpers";
import { createOrchestrator } from "../src/orchestrator";
import { createFeatureHandlers, renderSpec, SPEC_PATH } from "../src/feature-phases";
import { registerPhase, restorePhases, snapshotPhases, type PhaseSnapshot } from "../src/phases";
import { ScriptedRunner, type Handler } from "../src/runner/scripted";
import { openStore } from "../src/store";

const criteria = [
  { id: "AC-1", given: "ein Zauber auf Cooldown", when: "next_spell laeuft", then: "wird er\nuebersprungen", source: "task" },
  { id: "AC-2", given: "kein Zauber bereit", when: "next_spell laeuft", then: "ist das Ergebnis nil", source: "task" },
];

const analyst = (questions: string[] = []): Handler => async () => ({
  output: { summary: "Cooldowns beachten", title: "Cooldown-Rotation", criteria, out_of_scope: ["Ressourcen"], claims: [], questions },
});

const planFull = { summary: "Plan", size: "large", slices: [{ id: "S1", title: "Cooldown", criteria: ["AC-1", "AC-2"], files: ["src/rotation.lua"], depends_on: [] }], claims: [], questions: [] };
const planMissingAc2 = { ...planFull, slices: [{ ...planFull.slices[0]!, criteria: ["AC-1"] }] };
const techLead = (out: unknown): Handler => async () => ({ output: out });

function makePlugin(): string {
  const plugin = mkdtempSync(join(tmpdir(), "usac-plugin-"));
  for (const d of ["agents", "schemas", "gate-profiles", "routing.yaml"]) cpSync(join(REPO_ROOT, d), join(plugin, d), { recursive: true });
  mkdirSync(join(plugin, "workflows"));
  writeFileSync(
    join(plugin, "workflows/feature.yaml"),
    "name: feature\nphases:\n  - name: setup\n  - name: spec\n    role: analyst\n  - name: approve_spec\n    approval: spec\n  - name: plan\n    role: tech-lead\nescalation: default\n",
  );
  return plugin;
}

function setup(handlers: Record<string, Handler | Handler[]>, auto: string[] = []) {
  const project = setupProject();
  const home = tempHome();
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner(handlers);
  const orch = createOrchestrator({ store, runner, pluginRoot: makePlugin(), home, approvals: { auto }, graphify: false });
  const submit = (size?: "small" | "large") =>
    orch.submit({ projectPath: project, type: "feature", title: "Cooldown-Rotation", description: "Cooldowns beachten", ...(size ? { size } : {}) });
  return { project, store, runner, orch, submit };
}

describe("Feature-Handler spec/approve_spec/plan", () => {
  let snapshot: PhaseSnapshot;
  beforeEach(() => {
    snapshot = snapshotPhases();
    const h = createFeatureHandlers();
    registerPhase("spec", h.spec);
    registerPhase("approve_spec", h.approve_spec);
    registerPhase("plan", h.plan);
  });
  afterEach(() => restorePhases(snapshot));

  test("renderSpec ersetzt Zeilenumbrueche und hat alle Abschnitte", () => {
    const md = renderSpec({ id: "wi_x", title: "T" } as never, {
      summary: "S", title: "Titel", criteria: criteria as never, out_of_scope: ["Ressourcen"], claims: [], questions: ["Welche Einheit?"],
    });
    expect(md).toContain("# Spec: Titel");
    expect(md).toContain("Usac-Trace: wi_x");
    expect(md).toContain("wird er uebersprungen");
    for (const s of ["Akzeptanzkriterien", "Nicht im Umfang", "Offene Fragen"]) expect(md).toContain(s);
  });

  test("spec schreibt spec/feature.md aus der Analyst-Ausgabe", async () => {
    const { store, orch, submit } = setup({ analyst: analyst(), "tech-lead": techLead(planFull) });
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    const md = readFileSync(join(store.getWorkItem(wi.id)!.worktree!, SPEC_PATH), "utf8");
    expect(md).toContain("# Spec: Cooldown-Rotation");
    expect(md).toContain(`Usac-Trace: ${wi.id}`);
    expect(md).toContain("**AC-1**");
    expect(md).toContain("ist das Ergebnis nil");
    expect(store.events({ traceId: wi.id, type: "spec.written" })).toHaveLength(1);
  });

  test("Freigabe committet die Spec", async () => {
    const { store, orch, submit } = setup({ analyst: analyst(), "tech-lead": techLead(planFull) });
    const wi = await submit();
    await orch.run(wi.id);
    const pending = store.pendingApprovals().filter((a) => a.workItemId === wi.id);
    expect(pending.map((a) => a.kind)).toEqual(["spec"]);
    orch.approve(pending[0]!.id, true);
    expect((await orch.run(wi.id)).status).toBe("done");
    const wt = store.getWorkItem(wi.id)!.worktree!;
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(wt, "log", "-1", "--format=%s").startsWith("docs: Spec für")).toBe(true);
    expect(existsSync(join(wt, SPEC_PATH))).toBe(true);
    const s = store.getWorkItem(wi.id)!.state as { slices?: unknown[]; sliceOrder?: string[] };
    expect(s.sliceOrder).toEqual(["S1"]);
  });

  test("offene Fragen verhindern Auto-Freigabe", async () => {
    const { store, orch, submit } = setup({ analyst: analyst(["Welche Einheit?"]), "tech-lead": techLead(planFull) }, ["spec"]);
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("awaiting_approval");
    const pending = store.pendingApprovals().filter((a) => a.workItemId === wi.id);
    expect(pending.map((a) => a.kind)).toEqual(["spec"]);
  });

  test("ohne Fragen und mit Auto-Freigabe laeuft der Plan durch", async () => {
    const { orch, submit } = setup({ analyst: analyst(), "tech-lead": techLead(planFull) }, ["spec"]);
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("done");
  });

  test("Ablehnung führt zurück zu spec mit Notiz", async () => {
    const { store, runner, orch, submit } = setup({ analyst: analyst(), "tech-lead": techLead(planFull) });
    const wi = await submit();
    await orch.run(wi.id);
    const deny = async () => {
      const a = store.pendingApprovals().find((x) => x.workItemId === wi.id)!;
      orch.approve(a.id, false, "AC-2 fehlt");
      return orch.run(wi.id);
    };
    expect((await deny()).status).toBe("awaiting_approval");
    const prompts = runner.calls.filter((c) => c.role === "analyst").map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("AC-2 fehlt");
    expect(prompts[1]).toContain("AC-2 fehlt");
    expect((await deny()).status).toBe("awaiting_approval");
    expect((await deny()).status).toBe("escalated");
    expect(runner.calls.filter((c) => c.role === "analyst")).toHaveLength(3);
    expect(store.events({ traceId: wi.id, type: "spec.denied" })).toHaveLength(3);
  });

  test("ungültiger Plan wird mit Rückmeldung wiederholt, dann eskaliert", async () => {
    const { store, runner, orch, submit } = setup({ analyst: analyst(), "tech-lead": techLead(planMissingAc2) }, ["spec"]);
    const wi = await submit();
    expect((await orch.run(wi.id)).status).toBe("escalated");
    const prompts = runner.calls.filter((c) => c.role === "tech-lead").map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("AC-2 ist keinem Slice zugeordnet");
    expect(store.events({ traceId: wi.id, type: "plan.invalid" })).toHaveLength(2);
  });

  test("Größe: Nutzerangabe gewinnt", async () => {
    const user = setup({ analyst: analyst(), "tech-lead": techLead(planFull) }, ["spec"]);
    const a = await user.submit("small");
    expect((await user.orch.run(a.id)).status).toBe("done");
    expect(user.store.getWorkItem(a.id)!.size).toBe("small");
    expect(user.store.events({ traceId: a.id, type: "workitem.classified" }).map((e) => (e.data as { by: string }).by)).toEqual(["user"]);

    const def = setup({ analyst: analyst(), "tech-lead": techLead(planFull) }, ["spec"]);
    const b = await def.submit();
    expect((await def.orch.run(b.id)).status).toBe("done");
    expect(def.store.getWorkItem(b.id)!.size).toBe("large");
    const cls = def.store.events({ traceId: b.id, type: "workitem.classified" }).map((e) => e.data as { size: string; by: string });
    expect(cls.at(-1)).toEqual({ size: "large", by: "tech-lead" });
  });
});
