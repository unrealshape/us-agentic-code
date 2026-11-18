import { describe, expect, test } from "bun:test";
import type { WorkItemStatus } from "../../packages/shared/src/index";
import { openStore, type Store } from "../../packages/daemon/src/store";
import { acquireLeases, ensureLeaseSchema, expireLeases, heartbeat } from "../../packages/daemon/src/leases";

function setup(statusA: WorkItemStatus): Store {
  const store = openStore(":memory:");
  ensureLeaseSchema(store);
  for (const id of ["wi_a", "wi_b"]) {
    store.createWorkItem({ id, projectPath: "p", type: "bugfix", title: id, description: id, size: "small" });
  }
  store.updateWorkItem("wi_a", { status: statusA });
  store.updateWorkItem("wi_b", { status: "running" });
  return store;
}

describe("Datei-Leases (Abnahme)", () => {
  test("ein Lease ohne Heartbeat wird nach Timeout frei", () => {
    const store = setup("running");
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
    expect(expireLeases(store, 120_001)).toEqual([{ path: "src/a.lua", holder: "wi_a" }]);
    expect(acquireLeases(store, "p", "wi_b", ["src/a.lua"], 120_001)).toEqual({ ok: true });
  });

  test("Heartbeat hält den Lease", () => {
    const store = setup("running");
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
    expect(heartbeat(store, "wi_a", 100_000)).toBe(1);
    expect(expireLeases(store, 200_000)).toEqual([]);
  });

  test("Lease eines wartenden Auftrags verfällt nie", () => {
    const store = setup("awaiting_approval");
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
    expect(expireLeases(store, 10 * 86_400_000)).toEqual([]);
    expect(acquireLeases(store, "p", "wi_b", ["src/a.lua"], 10 * 86_400_000)).toEqual({
      ok: false,
      conflicts: [{ path: "src/a.lua", holder: "wi_a" }],
    });
  });
});
