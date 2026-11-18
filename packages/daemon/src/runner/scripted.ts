import type { RunOutcome, RunSpec, Runner } from "./types";

/** Ein Handler simuliert eine Agent-Session: er darf Dateien im Worktree aendern und liefert die Ausgabe. */
export type Handler = (spec: RunSpec, call: number) => Promise<{ output?: unknown; error?: string }>;

export interface RecordedCall {
  role: string;
  model: string;
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  networkAllow?: string[];
  disallowedTools?: string[];
}

/**
 * Deterministischer Runner fuer Tests. Pro Rolle ein Handler oder eine Liste von
 * Handlern (n-ter Aufruf nutzt den n-ten Handler, der letzte wiederholt sich).
 */
export class ScriptedRunner implements Runner {
  readonly calls: RecordedCall[] = [];
  private counts = new Map<string, number>();

  constructor(private handlers: Record<string, Handler | Handler[]>) {}

  async run(spec: RunSpec): Promise<RunOutcome> {
    const n = this.counts.get(spec.role) ?? 0;
    this.counts.set(spec.role, n + 1);
    this.calls.push({ role: spec.role, model: spec.model, prompt: spec.prompt, cwd: spec.cwd, env: spec.env, networkAllow: spec.networkAllow, disallowedTools: spec.disallowedTools });
    const h = this.handlers[spec.role];
    if (!h) return { ok: false, error: `Kein Handler fuer Rolle ${spec.role}` };
    const fn = Array.isArray(h) ? h[Math.min(n, h.length - 1)]! : h;
    const res = await fn(spec, n);
    if (res.error) return { ok: false, error: res.error, turns: 1 };
    return { ok: true, output: res.output, turns: 1, tokens: { input: 0, output: 0 } };
  }
}
