import type { z } from "zod";
import type { Finding, Model, Size } from "@usac/shared";
import { checkAdrRule } from "./adr-check";
import { git } from "./exec";
import { Escalate, type PhaseHandler } from "./phases";
import { reviewerPrompt, securityReviewerPrompt } from "./prompts";
import { resolveModel } from "./routing";
import { securityTriggers } from "./triggers";

export type ReviewSeat = { role: "code-reviewer" | "security-reviewer"; reason: "standard" | "size_large" | "security" };

type SeatFinding = z.infer<typeof Finding>;

/**
 * Review-Sitze: immer ein Code-Review; bei Security-Triggern zusaetzlich der security-reviewer,
 * sonst bei Groesse large ein zweites, unabhaengiges Code-Review. Hoechstens zwei Sitze.
 */
export function reviewSeats(size: Size, triggers: string[]): ReviewSeat[] {
  const seats: ReviewSeat[] = [{ role: "code-reviewer", reason: "standard" }];
  if (triggers.length) seats.push({ role: "security-reviewer", reason: "security" });
  else if (size === "large") seats.push({ role: "code-reviewer", reason: "size_large" });
  return seats;
}

/**
 * Review-Phase mit einem oder zwei Sitzen. Jeder Sitz bekommt nur den Diff (frischer Kontext,
 * keine Ausgabe des anderen Sitzes). Entschieden wird erst, wenn alle Sitze geurteilt haben.
 */
export function createReviewHandler(): PhaseHandler {
  return async (wi, ctx) => {
    const baseRef = ctx.state(wi).baseRef as string;
    await git(wi.worktree!, "add", "-A");
    const diff = await git(wi.worktree!, "diff", "--cached", baseRef);
    const changed = (await git(wi.worktree!, "diff", "--cached", "--name-only", baseRef))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const triggers = securityTriggers(changed, diff);
    ctx.emit(wi, "review.triggers", { triggers });

    // Regel 6 im Ziel-Projekt: neue Abhaengigkeit ohne ADR ist ein deterministischer high-Befund vor den Sitzen.
    const adr = ctx.profile.adr;
    const adrFindings: SeatFinding[] = adr.require_for_dependencies ? checkAdrRule(wi.worktree!, baseRef, adr.dir) : [];
    if (adr.require_for_dependencies) ctx.emit(wi, "review.adr", { dir: adr.dir, findings: adrFindings });

    const seats = reviewSeats(wi.size, triggers);
    const results: { seat: ReviewSeat; model: Model; blocking: boolean; findings: SeatFinding[] }[] = [];
    for (const seat of seats) {
      const route = resolveModel(ctx.routing, seat.role, { size: wi.size, budgetUsed: ctx.budgetUsed(), available: ctx.available });
      if (route.model === "fable") throw new Error("Fable im Review ist nicht erlaubt (ADR 0004)");
      let feedback: string | undefined;
      let done = false;
      for (let attempt = 1; attempt <= ctx.limits.reviewAttempts; attempt++) {
        const prompt = seat.role === "security-reviewer" ? securityReviewerPrompt(wi, diff, triggers, feedback) : reviewerPrompt(wi, diff, feedback);
        const res = await ctx.runRole(wi, seat.role, route.model, prompt);
        if (!res.ok) {
          feedback = res.feedback;
          continue;
        }
        const findings = res.output.findings;
        const blocking = res.output.verdict !== "approve" || findings.some((f) => f.severity === "critical" || f.severity === "high");
        ctx.emit(wi, "review.seat", { role: seat.role, reason: seat.reason, model: route.model, verdict: res.output.verdict, findings });
        results.push({ seat, model: route.model, blocking, findings });
        done = true;
        break;
      }
      if (!done) throw new Escalate(`Review (${seat.role}, ${seat.reason}) lieferte keine gueltige Ausgabe`);
    }

    const blocked = results.filter((r) => r.blocking);
    if (!blocked.length && !adrFindings.length) {
      ctx.emit(wi, "review.approved", { seats: results.map((r) => ({ role: r.seat.role, reason: r.seat.reason, model: r.model, findings: r.findings.length })) });
      return wi;
    }
    if (adrFindings.length) ctx.emit(wi, "review.changes_requested", { seat: { role: "adr-check", reason: "rule_6" }, findings: adrFindings });
    for (const r of blocked) ctx.emit(wi, "review.changes_requested", { seat: r.seat, findings: r.findings });
    // Zurueck zur Implementierung mit den ADR-Befunden und den Befunden aller Sitze als Rueckmeldung.
    const lines = [
      ...adrFindings.map((f) => `- (adr-check/rule_6) [${f.severity}] ${f.text}`),
      ...results.flatMap((r) => r.findings.map((f) => `- (${r.seat.role}/${r.seat.reason}) [${f.severity}] ${f.text}`)),
    ];
    return ctx.save(wi, { phase: "implement", lastFailure: "Review-Befunde:\n" + (lines.join("\n") || "- (ohne Einzelbefund) Aenderungen verlangt") });
  };
}
