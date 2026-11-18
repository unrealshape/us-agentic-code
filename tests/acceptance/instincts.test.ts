import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LearnerOutput } from "../../packages/shared/src/index";
import { openMemory } from "../../packages/daemon/src/memory";
import { activateInstinct, activeInstincts, proposeInstinct, recordOutcome } from "../../packages/daemon/src/instincts";
import { runRetrospective } from "../../packages/daemon/src/learn";
import type { PhaseContext } from "../../packages/daemon/src/phases";
import { loadRouting } from "../../packages/daemon/src/routing";
import { openStore, type WorkItem } from "../../packages/daemon/src/store";

const ROOT = resolve(import.meta.dir, "../..");
const exists = () => true;
const proposal = (p: Partial<{ text: string; role: string; glob: string; event_ids: number[] }> = {}) => ({
  text: "Cooldowns vor dem Zauber pruefen",
  role: "implementer",
  event_ids: [1],
  ...p,
});

function retroSetup(output: LearnerOutput) {
  const store = openStore(":memory:");
  const worktree = mkdtempSync(join(tmpdir(), "usac-retro-"));
  writeFileSync(join(worktree, "rotation.lua"), "local function cast(spell)\n  return spell.ready\nend\n");
  const created = store.createWorkItem({ id: "wi_retro", projectPath: worktree, type: "bugfix", title: "Rotation", description: "", size: "small" });
  store.updateWorkItem(created.id, { worktree, status: "done" });
  const wi = store.getWorkItem(created.id)!;
  const emit = (w: WorkItem, type: string, data: unknown = {}) =>
    store.append({ traceId: w.id, spanId: w.id, project: "p", type, actor: "orchestrator", data });
  const calls: { role: string; model: string; prompt: string }[] = [];
  const ctx = {
    store,
    pluginRoot: ROOT,
    routing: loadRouting(ROOT),
    autoApprovals: new Set<string>(),
    budgetUsed: () => 0,
    emit,
    state: (w: WorkItem) => (w.state ?? { phase: "done" }) as Record<string, unknown> & { phase: string },
    runRole: async (_w: WorkItem, role: string, model: string, prompt: string) => {
      calls.push({ role, model, prompt });
      return { ok: true, output: output };
    },
  } as unknown as PhaseContext;
  return { store, wi, ctx, emit, calls, memory: openMemory(":memory:") };
}

describe("Instincts (Phase 3)", () => {
  test("Vorschlag ohne Ereignis-Beleg wird abgelehnt", () => {
    const db = openMemory(":memory:");
    expect(() => proposeInstinct(db, proposal({ event_ids: [42] }), () => false)).toThrow();
    expect(() => proposeInstinct(db, proposal({ event_ids: [] }), exists)).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM instincts").get()).toEqual({ n: 0 });
  });

  test("Instinct gilt erst nach Freigabe", () => {
    const db = openMemory(":memory:");
    const id = proposeInstinct(db, proposal(), exists);
    expect(activeInstincts(db, "implementer", ["src/a.lua"])).toEqual([]);
    activateInstinct(db, id);
    const active = activeInstincts(db, "implementer", ["src/a.lua"]);
    expect(active.map((i) => i.id)).toEqual([id]);
    expect(active[0]!.status).toBe("active");
    expect(activeInstincts(db, "code-reviewer", ["src/a.lua"])).toEqual([]);
  });

  test("wirkungsloser Instinct wird stillgelegt", () => {
    const db = openMemory(":memory:");
    const id = proposeInstinct(db, proposal(), exists);
    activateInstinct(db, id);
    const retired: number[] = [];
    for (const recurred of [true, false, true, false, true]) retired.push(...recordOutcome(db, [id], recurred));
    expect(retired).toEqual([id]);
    const row = db.query("SELECT status, retire_reason, uses, recurrences FROM instincts WHERE id = ?").get(id);
    expect(row).toEqual({ status: "retired", retire_reason: "wirkungslos", uses: 5, recurrences: 3 });
    expect(activeInstincts(db, "implementer", ["src/a.lua"])).toEqual([]);
  });

  test("Glob begrenzt die Wirkung", () => {
    const db = openMemory(":memory:");
    const id = proposeInstinct(db, proposal({ glob: "src/**/*.lua" }), exists);
    activateInstinct(db, id);
    expect(activeInstincts(db, "implementer", ["docs/x.md"])).toEqual([]);
    expect(activeInstincts(db, "implementer", ["src/bot/rotation.lua"]).map((i) => i.id)).toEqual([id]);
  });

  test("Retrospektive nur nach Problemen", async () => {
    const smooth = retroSetup({ summary: "", instincts: [], memory: [], claims: [] });
    smooth.emit(smooth.wi, "workitem.done", {});
    await runRetrospective(smooth.wi, smooth.ctx, smooth.memory);
    expect(smooth.calls).toHaveLength(0);
    expect(smooth.store.events({ traceId: smooth.wi.id, type: "retro.skipped" })).toHaveLength(1);

    const rough = retroSetup({ summary: "", instincts: [], memory: [], claims: [] });
    const ev = rough.emit(rough.wi, "review.changes_requested", { findings: 1 });
    (rough.ctx.runRole as unknown) = async (_w: WorkItem, role: string, model: string, prompt: string) => {
      rough.calls.push({ role, model, prompt });
      return {
        ok: true,
        output: { summary: "s", instincts: [{ text: "Cooldowns pruefen", role: "implementer", event_ids: [ev.id] }], memory: [], claims: [] },
      };
    };
    await runRetrospective(rough.wi, rough.ctx, rough.memory);
    expect(rough.calls).toHaveLength(1);
    expect(rough.calls[0]!.role).toBe("learner");
    expect(rough.calls[0]!.model).toBe("haiku");
    expect(rough.store.events({ traceId: rough.wi.id, type: "retro.skipped" })).toHaveLength(0);
    expect(rough.store.events({ traceId: rough.wi.id, type: "instinct.proposed" })).toHaveLength(1);
    const pending = rough.store.pendingApprovals().filter((a) => a.kind === "instinct");
    expect(pending).toHaveLength(1);
    expect(activeInstincts(rough.memory, "implementer", [])).toEqual([]);
  });

  test("Memory-Vorschlag mit falschem Zitat bleibt proposed", async () => {
    const t = retroSetup({
      summary: "s",
      instincts: [],
      memory: [
        { kind: "convention", text: "Zauber pruefen ready", evidence: [{ type: "file", path: "rotation.lua", lines: [2, 2], quote: "return spell.cooldown == 0" }] },
        { kind: "convention", text: "cast liefert ready", evidence: [{ type: "file", path: "rotation.lua", lines: [2, 2], quote: "return spell.ready" }] },
      ],
      claims: [],
    });
    t.emit(t.wi, "anticheat.violation", { violations: [] });
    await runRetrospective(t.wi, t.ctx, t.memory);
    const rows = t.memory.query("SELECT text, status FROM entries ORDER BY id").all();
    expect(rows).toEqual([
      { text: "Zauber pruefen ready", status: "proposed" },
      { text: "cast liefert ready", status: "verified" },
    ]);
  });
});
