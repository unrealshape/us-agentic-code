import { describe, expect, test } from "bun:test";
import type { WorkItemStatus } from "../../shared/src/index";
import { openStore, type Store } from "../src/store";
import {
  HEARTBEAT_MS,
  LEASE_TIMEOUT_MS,
  PROJECT_WIDE,
  acquireLeases,
  ensureLeaseSchema,
  expireLeases,
  leasesOf,
  normalizeLeasePath,
  releaseLeases,
} from "../src/leases";

function setup(ids: string[] = ["wi_a", "wi_b"], project = "p"): Store {
  const store = openStore(":memory:");
  ensureLeaseSchema(store);
  for (const id of ids) {
    store.createWorkItem({ id, projectPath: project, type: "bugfix", title: id, description: id, size: "small" });
    store.updateWorkItem(id, { status: "running" });
  }
  return store;
}

describe("Datei-Leases", () => {
  test("Standardwerte", () => {
    expect(LEASE_TIMEOUT_MS).toBe(120_000);
    expect(HEARTBEAT_MS).toBe(30_000);
    expect(PROJECT_WIDE).toBe("*");
  });

  test("Pfade werden normalisiert", () => {
    expect(normalizeLeasePath("src\\a.lua")).toBe("src/a.lua");
    expect(normalizeLeasePath("./src/a.lua")).toBe("src/a.lua");
    expect(normalizeLeasePath("src//sub///a.lua")).toBe("src/sub/a.lua");
    expect(normalizeLeasePath(".\\src\\a.lua")).toBe("src/a.lua");
  });

  test("zwei Halter, gleiche Datei", () => {
    const store = setup();
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
    expect(acquireLeases(store, "p", "wi_b", ["src/b.lua", "src/a.lua", "src/c.lua"], 1)).toEqual({
      ok: false,
      conflicts: [{ path: "src/a.lua", holder: "wi_a" }],
    });
    // alles oder nichts: wi_b hält nichts
    expect(leasesOf(store, "wi_b")).toEqual([]);
    expect(acquireLeases(store, "p", "wi_a", ["src/b.lua", "src/c.lua"], 2)).toEqual({ ok: true });
  });

  test("eigener Halter darf erneut nehmen", () => {
    const store = setup();
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
    expect(acquireLeases(store, "p", "wi_a", ["src/a.lua", "src/b.lua"], 5)).toEqual({ ok: true });
    expect(leasesOf(store, "wi_a")).toEqual(["src/a.lua", "src/b.lua"]);
  });

  test("drei Schreibweisen ein Lease", () => {
    const store = setup();
    expect(acquireLeases(store, "p", "wi_a", ["src\\a.lua"], 0)).toEqual({ ok: true });
    expect(leasesOf(store, "wi_a")).toEqual(["src/a.lua"]);
    expect(acquireLeases(store, "p", "wi_b", ["./src/a.lua"], 1)).toEqual({
      ok: false,
      conflicts: [{ path: "src/a.lua", holder: "wi_a" }],
    });
    expect(acquireLeases(store, "p", "wi_b", ["src/a.lua"], 1)).toEqual({
      ok: false,
      conflicts: [{ path: "src/a.lua", holder: "wi_a" }],
    });
  });

  test("projektweiter Lease", () => {
    const store = setup(["wi_a", "wi_b", "wi_c"]);
    expect(acquireLeases(store, "p", "wi_a", [PROJECT_WIDE], 0)).toEqual({ ok: true });
    expect(acquireLeases(store, "p", "wi_b", ["src/x.lua"], 1)).toEqual({
      ok: false,
      conflicts: [{ path: "src/x.lua", holder: "wi_a" }],
    });
    // anderes Projekt unberührt
    expect(acquireLeases(store, "q", "wi_c", ["src/x.lua"], 1)).toEqual({ ok: true });

    expect(releaseLeases(store, "wi_a")).toBe(1);
    expect(acquireLeases(store, "p", "wi_b", ["src/x.lua"], 2)).toEqual({ ok: true });
    // umgekehrt: * scheitert, wenn ein Pfad vergeben ist
    expect(acquireLeases(store, "p", "wi_a", [PROJECT_WIDE], 3)).toEqual({
      ok: false,
      conflicts: [{ path: "src/x.lua", holder: "wi_b" }],
    });
    expect(leasesOf(store, "wi_a")).toEqual([]);
  });

  for (const status of ["done", "failed", "escalated"] as WorkItemStatus[]) {
    test(`Lease endet mit dem Auftrag (${status})`, () => {
      const store = setup();
      expect(acquireLeases(store, "p", "wi_a", ["src/a.lua"], 0)).toEqual({ ok: true });
      store.updateWorkItem("wi_a", { status });
      expect(expireLeases(store, 1)).toEqual([{ path: "src/a.lua", holder: "wi_a" }]);
      expect(leasesOf(store, "wi_a")).toEqual([]);
    });
  }

  test("releaseLeases gibt alle Pfade frei", () => {
    const store = setup();
    acquireLeases(store, "p", "wi_a", ["a", "b"], 0);
    expect(releaseLeases(store, "wi_a")).toBe(2);
    expect(releaseLeases(store, "wi_a")).toBe(0);
  });
});
