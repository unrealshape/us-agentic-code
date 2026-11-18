import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../packages/daemon/src/store";
import type { RunResult } from "../../packages/daemon/src/orchestrator";
import { LEASE_TIMEOUT_MS } from "../../packages/daemon/src/leases";
import { MAX_PARALLEL, createScheduler, ensureSlotSchema } from "../../packages/daemon/src/scheduler";

function addItems(store: Store, ids: string[]): void {
  for (const id of ids) {
    store.createWorkItem({ id, projectPath: "p", type: "bugfix", title: id, description: id, size: "small" });
  }
}

/** Attrappe fuer `Orchestrator["run"]`: haelt jedes Promise zurueck und zaehlt Gleichzeitigkeit. */
type Counter = { active: number; max: number };
function fakeRun(store: Store, global: Counter = { active: 0, max: 0 }) {
  const pending = new Map<string, (r: RunResult) => void>();
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const run = (id: string): Promise<RunResult> => {
    started.push(id);
    active++;
    maxActive = Math.max(maxActive, active);
    global.active++;
    global.max = Math.max(global.max, global.active);
    store.updateWorkItem(id, { status: "running" });
    return new Promise<RunResult>((resolve) => {
      pending.set(id, (r) => {
        active--;
        global.active--;
        pending.delete(id);
        store.updateWorkItem(id, { status: r.status });
        resolve(r);
      });
    });
  };
  return {
    run,
    started,
    pending,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    finish(id: string, status: RunResult["status"] = "done") {
      pending.get(id)!({ status, branch: null });
    },
  };
}

const slotCount = (store: Store) => (store.db.query("SELECT COUNT(*) AS n FROM slots").get() as { n: number }).n;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Queue und Slots (Abnahme)", () => {
  test("vier Runs gleichzeitig, nur drei laufen", async () => {
    const store = openStore(":memory:");
    const ids = ["wi_1", "wi_2", "wi_3", "wi_4"];
    addItems(store, ids);
    const fake = fakeRun(store);
    const sched = createScheduler({ store, run: fake.run, now: () => 1000 });
    expect(MAX_PARALLEL).toBe(3);
    for (const id of ids) sched.enqueue(id);
    expect(store.events({ type: "workitem.queued" }).map((e) => e.traceId)).toEqual(ids);

    expect(await sched.tick()).toEqual(["wi_1", "wi_2", "wi_3"]);
    expect(fake.active).toBe(3);
    expect(slotCount(store)).toBe(3);
    expect(await sched.tick()).toEqual([]);
    expect(fake.maxActive).toBe(3);

    fake.finish("wi_2");
    await new Promise((r) => setTimeout(r, 0));
    expect(await sched.tick()).toEqual(["wi_4"]);
    expect(fake.maxActive).toBe(3);
    expect(store.events({ type: "slot.acquired" }).map((e) => e.traceId)).toEqual(["wi_1", "wi_2", "wi_3", "wi_4"]);
    expect(store.events({ type: "slot.released" }).map((e) => e.traceId)).toEqual(["wi_2"]);

    for (const id of ["wi_1", "wi_3", "wi_4"]) fake.finish(id);
    await sched.idle();
    expect(slotCount(store)).toBe(0);
    expect(store.getWorkItem("wi_4")!.status).toBe("done");
  });

  test("zwei Prozesse teilen die Grenze", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usac-queue-"));
    tmpDirs.push(dir);
    const file = join(dir, "usac.db");
    const a = openStore(file);
    const b = openStore(file);
    ensureSlotSchema(a);
    ensureSlotSchema(b);
    const ids = ["wi_1", "wi_2", "wi_3", "wi_4", "wi_5", "wi_6"];
    addItems(a, ids);
    const global: Counter = { active: 0, max: 0 };
    const fakeA = fakeRun(a, global);
    const fakeB = fakeRun(b, global);
    const sa = createScheduler({ store: a, run: fakeA.run, now: () => 1000 });
    const sb = createScheduler({ store: b, run: fakeB.run, now: () => 1000 });
    for (const id of ids.slice(0, 3)) sa.enqueue(id);
    for (const id of ids.slice(3)) sb.enqueue(id);

    const [startedA, startedB] = await Promise.all([sa.tick(), sb.tick()]);
    expect(startedA.length + startedB.length).toBe(3);
    expect(new Set([...startedA, ...startedB]).size).toBe(3);
    expect(slotCount(a)).toBe(3);
    expect(await sb.tick()).toEqual([]);
    expect(await sa.tick()).toEqual([]);
    expect(fakeA.active + fakeB.active).toBe(3);

    for (const id of [...fakeA.pending.keys()]) fakeA.finish(id);
    for (const id of [...fakeB.pending.keys()]) fakeB.finish(id);
    await sa.idle();
    await sb.idle();
    const second = [...(await sb.tick()), ...(await sa.tick())];
    expect(second.length).toBe(3);
    expect(slotCount(a)).toBeLessThanOrEqual(3);
    expect(global.active).toBe(3);
    for (const id of [...fakeA.pending.keys()]) fakeA.finish(id);
    for (const id of [...fakeB.pending.keys()]) fakeB.finish(id);
    await sa.idle();
    await sb.idle();
    expect(slotCount(a)).toBe(0);
    expect(global.max).toBe(3);
    expect(ids.map((id) => a.getWorkItem(id)!.status)).toEqual(ids.map(() => "done"));
    a.close();
    b.close();
  });

  test("abgestürzter Run wird wieder eingereiht", async () => {
    const store = openStore(":memory:");
    ensureSlotSchema(store);
    addItems(store, ["wi_crash"]);
    store.updateWorkItem("wi_crash", { status: "running" });
    store.db.query("INSERT INTO slots (work_item_id, started_at, heartbeat_at) VALUES (?, 0, 0)").run("wi_crash");
    const fake = fakeRun(store);
    const sched = createScheduler({ store, run: fake.run, now: () => LEASE_TIMEOUT_MS + 1 });

    expect(await sched.tick()).toEqual(["wi_crash"]);
    expect(store.events({ type: "slot.expired" }).map((e) => e.traceId)).toEqual(["wi_crash"]);
    expect(store.events({ type: "workitem.queued" }).map((e) => e.traceId)).toEqual(["wi_crash"]);
    expect(fake.started).toEqual(["wi_crash"]);
    fake.finish("wi_crash");
    await sched.idle();
    expect(store.getWorkItem("wi_crash")!.status).toBe("done");
  });

  test("wartender Run belegt keinen Slot", async () => {
    const store = openStore(":memory:");
    addItems(store, ["wi_wait"]);
    const fake = fakeRun(store);
    const sched = createScheduler({ store, run: fake.run, now: () => 1000 });
    sched.enqueue("wi_wait");
    expect(await sched.tick()).toEqual(["wi_wait"]);
    fake.finish("wi_wait", "awaiting_approval");
    await sched.idle();
    expect(slotCount(store)).toBe(0);
    expect(store.getWorkItem("wi_wait")!.status).toBe("awaiting_approval");
    expect(await sched.tick()).toEqual([]);
    expect(fake.started).toEqual(["wi_wait"]);
  });
});
