import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../packages/daemon/src/store";
import type { RunResult } from "../../packages/daemon/src/orchestrator";
import { createScheduler } from "../../packages/daemon/src/scheduler";
import { NightConfig, isInWindow, loadNightConfig, windowStart } from "../../packages/daemon/src/night";

// Alle Zeitfenster-Tests laufen in lokaler Zeit Europe/Berlin (Zeitumstellung 2026-03-29).
let prevTz: string | undefined;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

function addItems(store: Store, ids: string[]): void {
  for (const id of ids) {
    store.createWorkItem({ id, projectPath: "p", type: "bugfix", title: id, description: id, size: "small" });
  }
}

/** Attrappe fuer `Orchestrator["run"]`: haelt jeden Lauf offen, bis der Test ihn beendet. */
function fakeRun(store: Store) {
  const pending = new Map<string, (r: RunResult) => void>();
  const started: string[] = [];
  const run = (id: string): Promise<RunResult> => {
    started.push(id);
    store.updateWorkItem(id, { status: "running" });
    return new Promise<RunResult>((resolve) => pending.set(id, resolve));
  };
  return { run, started, pending };
}

function appendEvent(store: Store, ts: Date, traceId: string, type: string, data: unknown = {}): void {
  store.append({ ts: ts.toISOString(), traceId, spanId: traceId, parentSpanId: null, project: "p", type, actor: "orchestrator", data });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Nachtbetrieb (Abnahme)", () => {
  test("Fenster über Mitternacht", () => {
    const W = "22:00-06:00";
    // Zeitzone muss die Berliner Sommer-/Winterzeit liefern, sonst ist der Test wertlos.
    expect(at(2026, 3, 29, 12, 0).getTimezoneOffset()).toBe(-120);
    expect(at(2026, 11, 19, 12, 0).getTimezoneOffset()).toBe(-60);

    expect(isInWindow(at(2026, 11, 19, 23, 30), W)).toBe(true);
    expect(isInWindow(at(2026, 11, 20, 5, 59), W)).toBe(true);
    expect(isInWindow(at(2026, 11, 20, 6, 0), W)).toBe(false);
    expect(isInWindow(at(2026, 11, 19, 21, 59), W)).toBe(false);
    expect(isInWindow(at(2026, 11, 19, 22, 0), W)).toBe(true);

    // Tag der Zeitumstellung (letzter Sonntag im März 2026): dieselben Ergebnisse.
    expect(isInWindow(at(2026, 3, 29, 23, 30), W)).toBe(true);
    expect(isInWindow(at(2026, 3, 30, 5, 59), W)).toBe(true);
    expect(isInWindow(at(2026, 3, 30, 6, 0), W)).toBe(false);
    expect(isInWindow(at(2026, 3, 29, 21, 59), W)).toBe(false);
    expect(isInWindow(at(2026, 3, 29, 5, 59), W)).toBe(true);

    expect(windowStart(at(2026, 3, 29, 23, 30), W)).toEqual(at(2026, 3, 29, 22, 0));
    expect(windowStart(at(2026, 3, 30, 5, 59), W)).toEqual(at(2026, 3, 29, 22, 0));
  });

  test("Nachtauftrag wartet bis zum Fenster", async () => {
    const store = openStore(":memory:");
    addItems(store, ["wi_day", "wi_night"]);
    store.updateWorkItem("wi_night", { state: { night: true } });
    const fake = fakeRun(store);
    let clock = at(2026, 11, 19, 15, 0).getTime();
    const sched = createScheduler({ store, run: fake.run, now: () => clock, night: NightConfig.parse({}) });
    sched.enqueue("wi_night");
    sched.enqueue("wi_day");

    expect(await sched.tick()).toEqual(["wi_day"]);
    expect(fake.started).toEqual(["wi_day"]);

    clock = at(2026, 11, 19, 22, 1).getTime();
    expect(await sched.tick()).toEqual(["wi_night"]);
    expect(fake.started).toEqual(["wi_day", "wi_night"]);
    for (const resolve of fake.pending.values()) resolve({ status: "done", branch: null });
    await sched.idle();
  });

  test("Budget stoppt neue Starts", async () => {
    const store = openStore(":memory:");
    addItems(store, ["wi_n1", "wi_n2", "wi_day"]);
    store.updateWorkItem("wi_n1", { state: { night: true } });
    store.updateWorkItem("wi_n2", { state: { night: true } });
    // Vor 22:00 verbrauchte Tokens zaehlen nicht; seit 22:00 genau 2 000 000.
    appendEvent(store, at(2026, 11, 19, 10, 0), "wi_old", "run.finished", { tokens: { input: 5_000_000, output: 0 } });
    appendEvent(store, at(2026, 11, 19, 22, 30), "wi_a", "run.finished", { tokens: { input: 1_500_000, output: 500_000 } });
    const fake = fakeRun(store);
    const clock = at(2026, 11, 19, 23, 0).getTime();
    const sched = createScheduler({ store, run: fake.run, now: () => clock, night: NightConfig.parse({}) });
    sched.enqueue("wi_n1");
    sched.enqueue("wi_n2");
    sched.enqueue("wi_day");

    expect(await sched.tick()).toEqual(["wi_day"]);
    expect(await sched.tick()).toEqual([]);
    expect(fake.started).toEqual(["wi_day"]);
    expect(store.events({ type: "night.budget_reached" }).length).toBe(1);
    for (const resolve of fake.pending.values()) resolve({ status: "done", branch: null });
    await sched.idle();
  });

  test("Morgenbericht", async () => {
    const store = openStore(":memory:");
    addItems(store, ["wi_done", "wi_esc", "wi_wait"]);
    appendEvent(store, at(2026, 11, 19, 23, 0), "wi_done", "run.finished", { tokens: { input: 1_000, output: 0 } });
    appendEvent(store, at(2026, 11, 19, 23, 10), "wi_done", "workitem.done");
    appendEvent(store, at(2026, 11, 20, 1, 0), "wi_esc", "workitem.escalated");
    appendEvent(store, at(2026, 11, 20, 2, 0), "wi_wait", "approval.requested", { approval_id: 1, kind: "h1" });
    const clock = at(2026, 11, 20, 6, 0).getTime();
    const sched = createScheduler({ store, run: fakeRun(store).run, now: () => clock, night: NightConfig.parse({}) });

    await sched.tick();
    const reports = store.pendingApprovals().filter((a) => a.kind === "night_report");
    expect(reports.length).toBe(1);
    const ctx = reports[0]!.context as { done: string[]; escalated: string[]; waiting: string[]; tokens: number };
    expect(ctx.done).toEqual(["wi_done"]);
    expect(ctx.escalated).toEqual(["wi_esc"]);
    expect(ctx.waiting).toEqual(["wi_wait"]);
    expect(ctx.tokens).toBe(1_000);

    // Nur einmal je Nacht, auch bei weiteren Ticks.
    await sched.tick();
    expect(store.pendingApprovals().filter((a) => a.kind === "night_report").length).toBe(1);
  });

  test("Konfiguration aus config.yaml, Schluessel night", () => {
    const home = mkdtempSync(join(tmpdir(), "usac-night-"));
    tmpDirs.push(home);
    expect(loadNightConfig(home)).toEqual(NightConfig.parse({}));
    writeFileSync(join(home, "config.yaml"), 'night:\n  window: "23:00-05:00"\n  max_tokens: 500000\n');
    expect(loadNightConfig(home)).toMatchObject({ window: "23:00-05:00", max_tokens: 500_000, max_parallel: 3 });
  });
});
