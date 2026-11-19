import { describe, expect, test } from "bun:test";
import type { UsacEvent } from "../../shared/src/index";
import { computeMetrics } from "../src/metrics";

// Montag, 2. November 2026, 00:00 UTC
const START = new Date("2026-11-02T00:00:00Z");
const OPTS = { periodStart: START, periodDays: 7, now: new Date("2026-11-15T12:00:00Z") };

let nextId = 1;
function ev(traceId: string, ts: string, type: string, data: Record<string, unknown> = {}, spanId = traceId): UsacEvent {
  return { id: nextId++, ts, traceId, spanId, project: "p", type, actor: "orchestrator", data };
}

function session(traceId: string, ts: string, role: string, model: string, ok: boolean, tokens = { input: 0, output: 0 }, turns = 1): UsacEvent[] {
  const span = `${traceId}-${role}-${nextId}`;
  return [
    ev(traceId, ts, "run.started", { role, model }, span),
    ev(traceId, ts, "run.finished", { role, model, ok, turns, tokens }, span),
  ];
}

describe("computeMetrics", () => {
  test("Velocity je Zeitraum", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "workitem.done"),
      ev("B", "2026-11-05T10:00:00Z", "workitem.done"),
      ev("C", "2026-11-10T10:00:00Z", "workitem.done"),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.periods.length).toBe(2);
    expect(m.periods[0]!.start).toBe("2026-11-02T00:00:00.000Z");
    expect(m.periods[0]!.end).toBe("2026-11-09T00:00:00.000Z");
    expect(m.periods[0]!.done).toBe(2);
    expect(m.periods[1]!.done).toBe(1);
  });

  test("Eskalationsrate", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "workitem.done"),
      ev("B", "2026-11-03T11:00:00Z", "workitem.done"),
      ev("C", "2026-11-03T12:00:00Z", "workitem.done"),
      ev("D", "2026-11-03T13:00:00Z", "workitem.escalated", { reason: "x" }),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.periods[0]!.escalated).toBe(1);
    expect(m.periods[0]!.done).toBe(3);
    expect(m.periods[0]!.escalationRate).toBe(0.25);
  });

  test("Tokens je Rolle und Modell", () => {
    const events = [
      ...session("A", "2026-11-03T10:00:00Z", "implementer", "sonnet", true, { input: 100, output: 50 }, 4),
      ev("A", "2026-11-03T10:01:00Z", "acceptance.green"),
      ...session("B", "2026-11-04T10:00:00Z", "implementer", "sonnet", true, { input: 200, output: 0 }, 6),
      ev("B", "2026-11-04T10:01:00Z", "acceptance.green"),
    ];
    const m = computeMetrics(events, OPTS);
    const s = m.roles.find((r) => r.role === "implementer" && r.model === "sonnet")!;
    expect(s.tokens).toBe(350);
    expect(s.runs).toBe(2);
    expect(s.okRuns).toBe(2);
    expect(s.avgTurns).toBe(5);
    expect(m.periods[0]!.tokens).toBe(350);
  });

  test("Erstversuch-Quote und Fehlversuche je Auftrag", () => {
    const events = [
      // Auftrag A: Implementer gelingt sofort
      ...session("A", "2026-11-03T10:00:00Z", "implementer", "sonnet", true),
      ev("A", "2026-11-03T10:01:00Z", "gate.passed"),
      ev("A", "2026-11-03T10:01:00Z", "acceptance.green"),
      // Auftrag B: erster Versuch scheitert am Gate, zweiter gelingt
      ...session("B", "2026-11-04T10:00:00Z", "implementer", "sonnet", true),
      ev("B", "2026-11-04T10:01:00Z", "gate.failed"),
      ...session("B", "2026-11-04T10:02:00Z", "implementer", "sonnet", true),
      ev("B", "2026-11-04T10:03:00Z", "acceptance.green"),
    ];
    const m = computeMetrics(events, OPTS);
    const s = m.roles.find((r) => r.role === "implementer" && r.model === "sonnet")!;
    expect(s.firstPassRate).toBe(0.5);
    expect(m.failuresPerItem).toEqual([
      { workItemId: "A", failures: 0 },
      { workItemId: "B", failures: 1 },
    ]);
  });

  test("Erstversuch scheitert an ungueltiger Ausgabe oder Review-Aenderungen", () => {
    const a = session("A", "2026-11-03T10:00:00Z", "test-engineer", "haiku", true);
    const events = [
      ...a,
      ev("A", "2026-11-03T10:00:30Z", "output.invalid", { role: "test-engineer" }, a[0]!.spanId),
      ...session("A", "2026-11-03T10:01:00Z", "test-engineer", "haiku", true),
      ...session("B", "2026-11-04T10:00:00Z", "implementer", "sonnet", true),
      ev("B", "2026-11-04T10:01:00Z", "acceptance.green"),
      ev("B", "2026-11-04T10:02:00Z", "review.changes_requested"),
      ...session("B", "2026-11-04T10:03:00Z", "implementer", "sonnet", true),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.roles.find((r) => r.role === "test-engineer")!.firstPassRate).toBe(0);
    expect(m.roles.find((r) => r.role === "implementer")!.firstPassRate).toBe(0);
    // Auftrag ohne acceptance.green: alle Implementer-Sessions sind Fehlversuche
    expect(m.failuresPerItem).toEqual([{ workItemId: "B", failures: 1 }]);
  });

  test("Eskalation zaehlt fuer Rolle und Modell der letzten Session", () => {
    const events = [
      ...session("A", "2026-11-03T10:00:00Z", "implementer", "sonnet", false),
      ev("A", "2026-11-03T10:01:00Z", "workitem.escalated", { reason: "x" }),
    ];
    const m = computeMetrics(events, OPTS);
    const s = m.roles.find((r) => r.role === "implementer")!;
    expect(s.escalations).toBe(1);
    expect(s.okRuns).toBe(0);
    expect(m.failuresPerItem).toEqual([{ workItemId: "A", failures: 1 }]);
  });

  test("Wartezeit", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "approval.requested", { approval_id: 1, kind: "h1" }),
      ev("A", "2026-11-03T10:30:00Z", "approval.resolved", { approval_id: 1, kind: "h1" }),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.approvalWait).toEqual([{ kind: "h1", count: 1, medianMs: 1_800_000, maxMs: 1_800_000 }]);
  });

  test("Wartezeit auch fuer approval.granted und approval.denied", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "approval.requested", { approval_id: 1, kind: "h2" }),
      ev("A", "2026-11-03T10:10:00Z", "approval.granted", { approval_id: 1, kind: "h2" }),
      ev("B", "2026-11-03T11:00:00Z", "approval.requested", { approval_id: 2, kind: "h2" }),
      ev("B", "2026-11-03T11:30:00Z", "approval.denied", { approval_id: 2, kind: "h2" }),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.approvalWait).toEqual([{ kind: "h2", count: 2, medianMs: 1_200_000, maxMs: 1_800_000 }]);
  });

  test("offene Freigabe zählt nicht", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "approval.requested", { approval_id: 1, kind: "h1" }),
      ev("A", "2026-11-03T10:30:00Z", "approval.resolved", { approval_id: 1, kind: "h1" }),
      ev("B", "2026-11-03T11:00:00Z", "approval.requested", { approval_id: 2, kind: "h1" }),
    ];
    const m = computeMetrics(events, OPTS);
    expect(m.approvalWait).toEqual([{ kind: "h1", count: 1, medianMs: 1_800_000, maxMs: 1_800_000 }]);
  });

  test("leeres Log", () => {
    const m = computeMetrics([], OPTS);
    expect(m).toEqual({ periods: [], failuresPerItem: [], roles: [], approvalWait: [] });
  });

  test("Zeitraum ohne Abschluesse hat Rate 0 statt NaN", () => {
    const events = [...session("A", "2026-11-03T10:00:00Z", "analyst", "opus", true)];
    const m = computeMetrics(events, OPTS);
    expect(m.periods.length).toBe(2);
    for (const s of m.periods) expect(s.escalationRate).toBe(0);
  });

  test("unsortierte Events werden nach id verarbeitet", () => {
    const events = [
      ev("A", "2026-11-03T10:00:00Z", "approval.requested", { approval_id: 1, kind: "h1" }),
      ev("A", "2026-11-03T10:30:00Z", "approval.resolved", { approval_id: 1, kind: "h1" }),
    ].reverse();
    const m = computeMetrics(events, OPTS);
    expect(m.approvalWait[0]!.count).toBe(1);
  });
});
