import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restorePhases, snapshotPhases, Escalate, type PhaseContext } from "../../packages/daemon/src/phases";
import { createIntegratorHandlers, type CmdResult } from "../../packages/daemon/src/integrator";
import type { WorkItem } from "../../packages/daemon/src/store";

let snap: ReturnType<typeof snapshotPhases>;
beforeEach(() => { snap = snapshotPhases(); });
afterEach(() => restorePhases(snap));

type Approval = { id: number; status: "pending" | "granted" | "denied"; note?: string | null };

function setup(opts: { ghAuth?: number; approval?: Approval | null } = {}) {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const git = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    gitCalls.push(args);
    return { exitCode: 0, output: args[0] === "log" ? "feat: titel\n\nUsac-Trace: wi1" : "" };
  };
  const gh = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    ghCalls.push(args);
    if (args[0] === "auth") return { exitCode: opts.ghAuth ?? 0, output: "" };
    if (args[0] === "pr" && args[1] === "create") return { exitCode: 0, output: "https://github.com/x/y/pull/1" };
    return { exitCode: 0, output: "" };
  };
  let state: Record<string, unknown> & { phase: string } = { phase: "merge", h2ApprovalId: opts.approval ? opts.approval.id : undefined };
  const wi = { id: "wi1", title: "titel", branch: "usac/wi1", worktree: "/tmp/wt", projectPath: "/tmp/p", status: "running" } as unknown as WorkItem;
  const events: string[] = [];
  const ctx = {
    store: {
      getApproval: () => opts.approval ?? null,
      createApproval: () => ({ id: 7, status: "pending" }),
      resolveApproval: () => {},
    },
    autoApprovals: new Set<string>(),
    emit: (_w: WorkItem, type: string) => { events.push(type); },
    state: () => state,
    save: (w: WorkItem, patch: Record<string, unknown>, extra: Partial<WorkItem> = {}) => {
      state = { ...state, ...patch };
      return { ...w, ...extra } as WorkItem;
    },
  } as unknown as PhaseContext;
  return { h: createIntegratorHandlers({ git, gh }), gitCalls, ghCalls, wi, ctx, events };
}

describe("Integrator", () => {
  test("ohne Freigabe H2 kein Merge", async () => {
    for (const approval of [null, { id: 3, status: "pending" } as Approval, { id: 3, status: "denied" } as Approval]) {
      const t = setup({ approval });
      try { await t.h.merge(t.wi, t.ctx); } catch (e) { expect(e).toBeInstanceOf(Escalate); }
      expect(t.ghCalls.length).toBe(0);
    }
    const ok = setup({ approval: { id: 3, status: "granted" } });
    await ok.h.merge(ok.wi, ok.ctx);
    expect(ok.ghCalls.some((a) => a[0] === "pr" && a[1] === "merge" && a.includes("--squash") && a.includes("--delete-branch"))).toBe(true);
  });

  test("nie Push auf main", async () => {
    const t = setup();
    await t.h.push(t.wi, t.ctx);
    const push = t.gitCalls.find((a) => a[0] === "push")!;
    expect(push).toEqual(["push", "-u", "origin", "usac/wi1"]);
    expect(push).not.toContain("main");
    expect(push).not.toContain("--force");
    const bad = setup();
    bad.wi.branch = "main";
    await expect(bad.h.push(bad.wi, bad.ctx)).rejects.toThrow();
    expect(bad.gitCalls.some((a) => a[0] === "push")).toBe(false);
  });

  test("gh nicht angemeldet bricht mit klarer Meldung ab", async () => {
    const t = setup({ ghAuth: 1 });
    await expect(t.h.pr(t.wi, t.ctx)).rejects.toThrow(/gh auth login/);
    expect(t.ghCalls.some((a) => a[0] === "pr")).toBe(false);
  });
});
