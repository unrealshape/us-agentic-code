import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restorePhases, snapshotPhases, Escalate, type PhaseContext } from "../../packages/daemon/src/phases";
import { createIntegratorHandlers, type CmdResult } from "../../packages/daemon/src/integrator";
import type { WorkItem } from "../../packages/daemon/src/store";

let snap: ReturnType<typeof snapshotPhases>;
beforeEach(() => { snap = snapshotPhases(); });
afterEach(() => restorePhases(snap));

type Approval = { id: number; status: "pending" | "granted" | "denied"; note?: string | null; context?: unknown };

function setup(opts: { ghAuth?: number; approval?: Approval | null; prOutput?: string; prUrl?: string; existingPr?: { url: string; state: string } } = {}) {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const git = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    gitCalls.push(args);
    return { exitCode: 0, output: args[0] === "log" ? "feat: titel\n\nUsac-Trace: wi1" : "" };
  };
  const gh = async (_cwd: string, args: string[]): Promise<CmdResult> => {
    ghCalls.push(args);
    if (args[0] === "auth") return { exitCode: opts.ghAuth ?? 0, output: "" };
    if (args[0] === "pr" && args[1] === "view") {
      return opts.existingPr
        ? { exitCode: 0, output: JSON.stringify(opts.existingPr) }
        : { exitCode: 1, output: 'no pull requests found for branch "usac/wi1"' };
    }
    if (args[0] === "pr" && args[1] === "create") {
      if (opts.existingPr) return { exitCode: 1, output: `a pull request for branch "usac/wi1" into branch "develop" already exists:\n${opts.existingPr.url}` };
      return { exitCode: 0, output: opts.prOutput ?? "https://github.com/x/y/pull/1" };
    }
    return { exitCode: 0, output: "" };
  };
  let state: Record<string, unknown> & { phase: string } = { phase: "merge", h2ApprovalId: opts.approval ? opts.approval.id : undefined, prUrl: opts.prUrl ?? "https://github.com/x/y/pull/1" };
  const wi = { id: "wi1", title: "titel", branch: "usac/wi1", worktree: "/tmp/wt", projectPath: "/tmp/p", status: "running" } as unknown as WorkItem;
  const events: string[] = [];
  const ctx = {
    store: {
      getApproval: () => opts.approval ?? null,
      createApproval: () => ({ id: 7, status: "pending" }),
      resolveApproval: () => {},
    },
    profile: { base_branch: "develop" },
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
    const ok = setup({ approval: { id: 3, status: "granted", context: { prUrl: "https://github.com/x/y/pull/1" } } });
    await ok.h.merge(ok.wi, ok.ctx);
    expect(ok.ghCalls.some((a) => a[0] === "pr" && a[1] === "merge" && a.includes("--squash") && a.includes("--delete-branch"))).toBe(true);
  });

  test("nie Push auf main", async () => {
    const t = setup();
    await t.h.push(t.wi, t.ctx);
    const push = t.gitCalls.find((a) => a[0] === "push")!;
    expect(push).toEqual(["push", "-u", "origin", "refs/heads/usac/wi1:refs/heads/usac/wi1"]);
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

  test("PR nutzt Base-Branch aus dem Projektprofil", async () => {
    const t = setup();
    await t.h.pr(t.wi, t.ctx);
    const create = t.ghCalls.find((a) => a[0] === "pr" && a[1] === "create")!;
    expect(create[create.indexOf("--base") + 1]).toBe("develop");
  });

  test("PR-URL wird per Regex gefunden, ohne URL Escalate", async () => {
    const t = setup({ prOutput: ["Warning: 1 uncommitted change", "https://github.com/x/y/pull/42", "fertig"].join("\n") });
    const out = await t.h.pr(t.wi, t.ctx);
    expect((t.ctx.state(out) as { prUrl?: string }).prUrl).toBe("https://github.com/x/y/pull/42");
    const none = setup({ prOutput: "Warning: kein Link" });
    await expect(none.h.pr(none.wi, none.ctx)).rejects.toBeInstanceOf(Escalate);
  });

  test("erneuter pr nutzt den vorhandenen offenen PR des Branches", async () => {
    const t = setup({ existingPr: { url: "https://github.com/x/y/pull/5", state: "OPEN" } });
    const out = await t.h.pr(t.wi, t.ctx);
    expect((t.ctx.state(out) as { prUrl?: string }).prUrl).toBe("https://github.com/x/y/pull/5");
    expect(t.ghCalls.some((a) => a[0] === "pr" && a[1] === "create")).toBe(false);
    expect(t.events).toContain("pr.reused");
    // Ein geschlossener PR wird nicht wiederverwendet.
    const closed = setup({ existingPr: { url: "https://github.com/x/y/pull/5", state: "CLOSED" } });
    await expect(closed.h.pr(closed.wi, closed.ctx)).rejects.toBeInstanceOf(Escalate);
    expect(closed.ghCalls.some((a) => a[0] === "pr" && a[1] === "create")).toBe(true);
  });

  test("H2 gilt nur fuer die PR-URL, fuer die sie erteilt wurde", async () => {
    const t = setup({ approval: { id: 3, status: "granted", context: { prUrl: "https://github.com/x/y/pull/1" } }, prUrl: "https://github.com/x/y/pull/2" });
    await expect(t.h.merge(t.wi, t.ctx)).rejects.toBeInstanceOf(Escalate);
    expect(t.ghCalls.length).toBe(0);
    const n = setup({ approval: { id: 3, status: "granted", context: { prUrl: "https://github.com/x/y/pull/1" } }, prOutput: "https://github.com/x/y/pull/2" });
    const out = await n.h.pr(n.wi, n.ctx);
    expect((n.ctx.state(out) as { h2ApprovalId?: number }).h2ApprovalId).toBeUndefined();
  });
});
