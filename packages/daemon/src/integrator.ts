import { sh } from "./exec";
import { Escalate, type PhaseContext, type PhaseHandler } from "./phases";

export interface CmdResult {
  exitCode: number;
  output: string;
}

/** Fuehrt `git <args>` in cwd aus. Injizierbar, damit Tests ohne Netz laufen. */
export type GitRunner = (cwd: string, args: string[]) => Promise<CmdResult>;
/** Fuehrt `gh <args>` in cwd aus. Injizierbar, damit Tests ohne Netz laufen. */
export type GhRunner = (cwd: string, args: string[]) => Promise<CmdResult>;

const quote = (a: string) => `'${a.replace(/'/g, `'\''`)}'`;
export const realGit: GitRunner = async (cwd, args) => {
  const r = await sh(`git -c core.autocrlf=false ${args.map(quote).join(" ")}`, cwd, 300_000);
  return { exitCode: r.exitCode, output: r.output };
};
export const realGh: GhRunner = async (cwd, args) => {
  const r = await sh(`gh ${args.map(quote).join(" ")}`, cwd, 300_000);
  return { exitCode: r.exitCode, output: r.output };
};

/**
 * Erlaubt sind nur usac/<id> und feature/*. Feature-Branches bleiben erlaubt, weil Phase-1-Auftraege
 * auch auf feature/* arbeiten koennen und diese nie der Basis-Branch sind.
 */
function safeBranch(wi: { branch: string | null }): string {
  const b = wi.branch ?? "";
  // main/master: zweite Schutzlinie, die Whitelist unten schliesst beide schon aus.
  if (!/^(usac\/[\w.-]+|feature\/[\w./-]+)$/.test(b) || /^(main|master)$/.test(b)) {
    throw new Escalate(`Push abgelehnt: Branch "${b}" ist nicht usac/<id> oder feature/*`);
  }
  return b;
}

export function createIntegratorHandlers(deps: { git: GitRunner; gh: GhRunner }) {
  const { git, gh } = deps;

  async function requireGh(cwd: string) {
    const r = await gh(cwd, ["auth", "status"]);
    if (r.exitCode !== 0) {
      throw new Escalate("gh ist nicht angemeldet. Bitte `gh auth login` ausfuehren und den Lauf fortsetzen.");
    }
  }

  const push: PhaseHandler = async (wi, ctx) => {
    const branch = safeBranch(wi);
    const r = await git(wi.worktree!, ["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    if (r.exitCode !== 0) throw new Escalate(`git push fehlgeschlagen: ${r.output}`);
    ctx.emit(wi, "pushed", { branch });
    return wi;
  };

  const pr: PhaseHandler = async (wi, ctx) => {
    const branch = safeBranch(wi);
    const cwd = wi.worktree!;
    await requireGh(cwd);
    const log = await git(cwd, ["log", "-1", "--format=%B"]);
    const body = log.exitCode === 0 && log.output ? log.output : `Usac-Trace: ${wi.id}`;
    const r = await gh(cwd, ["pr", "create", "--base", ctx.profile.base_branch, "--head", branch, "--title", wi.title, "--body", body]);
    if (r.exitCode !== 0) throw new Escalate(`gh pr create fehlgeschlagen: ${r.output}`);
    const prUrl = r.output.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
    if (!prUrl) throw new Escalate(`PR-URL nicht in der gh-Ausgabe gefunden: ${r.output}`);
    ctx.emit(wi, "pr.created", { branch, url: prUrl });
    // Eine fruehere H2-Freigabe gilt nur fuer ihre eigene PR-URL.
    const old = ctx.state(wi) as { prUrl?: string };
    return ctx.save(wi, old.prUrl && old.prUrl !== prUrl ? { prUrl, h2ApprovalId: undefined } : { prUrl });
  };

  const approve_h2: PhaseHandler = async (wi, ctx) => {
    const { store } = ctx;
    const s = ctx.state(wi) as { h2ApprovalId?: number; prUrl?: string };
    let approval = s.h2ApprovalId ? store.getApproval(s.h2ApprovalId) : null;
    if (approval && (approval.context as { prUrl?: string } | null)?.prUrl !== s.prUrl) approval = null;
    if (!approval) {
      approval = store.createApproval(wi.id, "h2", { title: wi.title, prUrl: s.prUrl, branch: wi.branch });
      ctx.emit(wi, "approval.requested", { approval_id: approval.id, kind: "h2", pr: s.prUrl });
      wi = ctx.save(wi, { h2ApprovalId: approval.id });
      if (ctx.autoApprovals.has("h2")) {
        store.resolveApproval(approval.id, true, "automatisch (Konfiguration)");
        approval = store.getApproval(approval.id)!;
      }
    }
    if (approval.status === "pending") return ctx.save(wi, {}, { status: "awaiting_approval" });
    if (approval.status === "denied") throw new Escalate(`Merge abgelehnt: ${approval.note ?? ""}`);
    ctx.emit(wi, "approval.granted", { approval_id: approval.id, kind: "h2" });
    return ctx.save(wi, {}, { status: "running" });
  };

  const merge: PhaseHandler = async (wi, ctx: PhaseContext) => {
    const s = ctx.state(wi) as { h2ApprovalId?: number; prUrl?: string };
    const approval = s.h2ApprovalId ? ctx.store.getApproval(s.h2ApprovalId) : null;
    if (!approval || approval.status !== "granted") {
      throw new Escalate("Merge ohne erteilte Freigabe H2 nicht erlaubt");
    }
    const approvedUrl = (approval.context as { prUrl?: string } | null)?.prUrl;
    if (!s.prUrl || approvedUrl !== s.prUrl) {
      throw new Escalate("Freigabe H2 gehoert nicht zu diesem PR");
    }
    const branch = safeBranch(wi);
    const r = await gh(wi.worktree!, ["pr", "merge", s.prUrl ?? branch, "--squash", "--delete-branch"]);
    if (r.exitCode !== 0) throw new Escalate(`gh pr merge fehlgeschlagen: ${r.output}`);
    ctx.emit(wi, "merged", { branch, pr: s.prUrl });
    wi = ctx.save(wi, { phase: "done" }, { status: "done" });
    ctx.emit(wi, "workitem.done", { branch });
    return wi;
  };

  return { push, pr, approve_h2, merge };
}
