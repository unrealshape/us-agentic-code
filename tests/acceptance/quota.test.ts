import { describe, expect, test } from "bun:test";
import { openStore } from "../../packages/daemon/src/store";
import { budgetUsedFraction } from "../../packages/daemon/src/quota";

function finished(store: ReturnType<typeof openStore>, ts: string, input: number, output: number) {
  store.append({
    ts,
    traceId: "t1",
    spanId: "s1",
    project: "p",
    type: "run.finished",
    actor: "orchestrator",
    data: { tokens: { input, output } },
  } as never);
}

describe("Kontingent", () => {
  test("ab 75 % liefert Anteil 0,75 und ist als Schaetzung markiert", () => {
    const store = openStore(":memory:");
    finished(store, "2026-11-10T10:00:00.000Z", 300_000, 100_000);
    finished(store, "2026-11-11T10:00:00.000Z", 200_000, 150_000);
    const r = budgetUsedFraction(store, new Date("2026-11-01T00:00:00.000Z"), 1_000_000);
    expect(r.fraction).toBe(0.75);
    expect(r.estimated).toBe(true);
  });

  test("Events vor dem Stichtag zaehlen nicht", () => {
    const store = openStore(":memory:");
    finished(store, "2026-10-01T10:00:00.000Z", 500_000, 400_000);
    finished(store, "2026-11-11T10:00:00.000Z", 100_000, 150_000);
    const r = budgetUsedFraction(store, new Date("2026-11-01T00:00:00.000Z"), 1_000_000);
    expect(r.fraction).toBe(0.25);
  });
});
