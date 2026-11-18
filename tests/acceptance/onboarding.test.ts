import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExplorerOutput } from "../../packages/shared/src/index";
import { loadProjectProfile } from "../../packages/daemon/src/config";
import { detectStacks } from "../../packages/daemon/src/detect";
import { openMemory, search } from "../../packages/daemon/src/memory";
import { createOnboarding } from "../../packages/daemon/src/onboarding";
import { ScriptedRunner, type Handler } from "../../packages/daemon/src/runner/scripted";
import { openStore } from "../../packages/daemon/src/store";
import { git, REPO_ROOT, setupProject } from "../helpers";

/** Kopie von lua-rotation als Git-Repo, ohne `.usac/`. */
function project(): string {
  const dir = setupProject("lua-rotation");
  git(dir, "rm", "-r", "-q", ".usac");
  git(dir, "commit", "-q", "-m", "chore: ohne Profil");
  return dir;
}

const CONVENTION = {
  text: "Module geben eine Tabelle M zurueck",
  level: "EXTRACTED" as const,
  evidence: [{ type: "file" as const, path: "src/rotation.lua", lines: [16, 16] as [number, number], quote: "return M" }],
};

function explorerOutput(over: Partial<ExplorerOutput> = {}): ExplorerOutput {
  return {
    summary: "Lua-Projekt mit busted-Tests",
    languages: ["lua"],
    commands: { test: "busted", lint: "luacheck src spec" },
    conventions: [CONVENTION],
    claims: [],
    questions: [],
    ...over,
  };
}

const ok = (out: ExplorerOutput = explorerOutput()): Handler => async () => ({ output: out });

function setup(explorer: Handler | Handler[]) {
  const home = mkdtempSync(join(tmpdir(), "usac-onb-home-"));
  const store = openStore(join(home, "usac.db"));
  const runner = new ScriptedRunner({ explorer });
  const memoryPath = join(home, "memory.db");
  const onb = createOnboarding({ store, runner, pluginRoot: REPO_ROOT, memoryPath });
  const types = (id: string) => store.events({ traceId: id }).map((e) => e.type);
  return { store, runner, onb, memoryPath, types };
}

describe("Onboarding (Phase 3)", () => {
  test("Onboarding erzeugt ein Profil, das erst nach Bestätigung geschrieben wird", async () => {
    const dir = project();
    const { store, runner, onb, types } = setup(ok());
    const r = await onb.start(dir);
    expect(r.status).toBe("awaiting_approval");
    expect(store.getWorkItem(r.workItemId)!.type).toBe("onboarding");
    const pending = store.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(r.approvalId!);
    expect(pending[0]!.kind).toBe("profile");
    expect((pending[0]!.context as { gate_profile: string }).gate_profile).toBe("lua");
    expect(existsSync(join(dir, ".usac/project.yaml"))).toBe(false);

    // Explorer laeuft im Projektordner, auf Haiku.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.cwd).toBe(dir);
    expect(runner.calls[0]!.model).toBe("haiku");

    // Ohne Entscheidung bleibt alles offen.
    expect((await onb.resume(r.workItemId)).status).toBe("awaiting_approval");
    expect(existsSync(join(dir, ".usac/project.yaml"))).toBe(false);

    store.resolveApproval(r.approvalId!, true);
    expect((await onb.resume(r.workItemId)).status).toBe("done");
    const path = join(dir, ".usac/project.yaml");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("gate_profile: lua");
    expect(raw).toContain("base_branch: main");
    expect(raw).toContain("confirmed_at");
    const profile = loadProjectProfile(dir);
    expect(profile.gate_profile).toBe("lua");
    expect(profile.commands?.test).toBe("busted");
    expect(profile.adr).toEqual({ dir: "docs/adr", require_for_dependencies: true });
    expect(raw).not.toContain("conventions");

    const t = types(r.workItemId);
    expect(t.indexOf("onboarding.detected")).toBeLessThan(t.indexOf("onboarding.proposed"));
    expect(t.indexOf("onboarding.proposed")).toBeLessThan(t.indexOf("onboarding.written"));
    const written = store.events({ traceId: r.workItemId, type: "onboarding.written" })[0]!;
    expect(written.data).toEqual({ path });
    const detected = store.events({ traceId: r.workItemId, type: "onboarding.detected" })[0]!;
    expect((detected.data as { stacks: { profile: string }[] }).stacks[0]!.profile).toBe("lua");
  });

  test("Konventionen mit Beleg landen verifiziert im Memory", async () => {
    const dir = project();
    const unbelegt = { text: "Tests laufen schnell", level: "UNKNOWN" as const, evidence: [] };
    const { store, onb, memoryPath } = setup(ok(explorerOutput({ conventions: [CONVENTION, unbelegt] })));
    const r = await onb.start(dir);
    const proposal = store.getApproval(r.approvalId!)!.context as { conventions: string[] };
    expect(proposal.conventions).toEqual([CONVENTION.text]);
    store.resolveApproval(r.approvalId!, true);
    expect((await onb.resume(r.workItemId)).status).toBe("done");
    const db = openMemory(memoryPath);
    const hits = search(db, "Tabelle");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("convention");
    expect(hits[0]!.status).toBe("verified");
    expect(hits[0]!.evidence[0]!.file).toBe("src/rotation.lua");
    expect(search(db, "schnell")).toHaveLength(0);
    db.close();
  });

  test("ungültiger Beleg verwirft die Ausgabe", async () => {
    const dir = project();
    const falsch = { ...CONVENTION, evidence: [{ ...CONVENTION.evidence[0]!, quote: "return Foo" }] };
    const { store, runner, onb, types } = setup([ok(explorerOutput({ conventions: [falsch] })), ok()]);
    const r = await onb.start(dir);
    expect(r.status).toBe("awaiting_approval");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.prompt).toContain("Zitat steht nicht");
    expect(types(r.workItemId)).toContain("evidence.invalid");
    const proposal = store.getApproval(r.approvalId!)!.context as { conventions: string[] };
    expect(proposal.conventions).toEqual([CONVENTION.text]);
  });

  test("dauerhaft ungültige Ausgabe eskaliert ohne Profil", async () => {
    const dir = project();
    const falsch = { ...CONVENTION, evidence: [{ ...CONVENTION.evidence[0]!, quote: "return Foo" }] };
    const { store, runner, onb } = setup(ok(explorerOutput({ conventions: [falsch] })));
    const r = await onb.start(dir);
    expect(r.status).toBe("escalated");
    expect(runner.calls).toHaveLength(2);
    expect(store.pendingApprovals()).toHaveLength(0);
    expect(existsSync(join(dir, ".usac/project.yaml"))).toBe(false);
  });

  test("Ablehnung mit Notiz erkundet einmal neu, dann Eskalation", async () => {
    const dir = project();
    const { store, runner, onb, types } = setup(ok());
    const r = await onb.start(dir);
    store.resolveApproval(r.approvalId!, false, "Testbefehl ist busted --output=TAP");
    const second = await onb.resume(r.workItemId);
    expect(second.status).toBe("awaiting_approval");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.prompt).toContain("Testbefehl ist busted --output=TAP");
    const pending = store.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("profile");
    expect(pending[0]!.id).not.toBe(r.approvalId!);

    store.resolveApproval(pending[0]!.id, false, "immer noch falsch");
    expect((await onb.resume(r.workItemId)).status).toBe("escalated");
    expect(runner.calls).toHaveLength(2);
    expect(existsSync(join(dir, ".usac/project.yaml"))).toBe(false);
    expect(types(r.workItemId)).toContain("workitem.escalated");
  });

  test("vorhandenes Profil wird ohne force nicht überschrieben", async () => {
    const dir = project();
    mkdirSync(join(dir, ".usac"));
    writeFileSync(join(dir, ".usac/project.yaml"), "name: alt\ngate_profile: lua\n");
    const { store, runner, onb } = setup(ok());
    await expect(onb.start(dir)).rejects.toThrow("--force");
    expect(runner.calls).toHaveLength(0);
    expect(store.listWorkItems()).toHaveLength(0);

    const r = await onb.start(dir, true);
    expect(r.status).toBe("awaiting_approval");
    expect(readFileSync(join(dir, ".usac/project.yaml"), "utf8")).toContain("name: alt");
    store.resolveApproval(r.approvalId!, true);
    expect((await onb.resume(r.workItemId)).status).toBe("done");
    expect(loadProjectProfile(dir).confirmed_at).toBeString();
  });

  test("detectStacks", () => {
    const dir = project();
    const stacks = detectStacks(dir, REPO_ROOT);
    expect(stacks[0]).toEqual({ profile: "lua", files: 2 });
    expect(stacks.every((s) => s.files > 0)).toBe(true);
  });
});
