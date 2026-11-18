import type { Model } from "@usac/shared";

export interface RunSpec {
  role: string;
  model: Model;
  prompt: string;
  cwd: string;
  /** Rollen-Prompt, wird an den Standard-Systemprompt angehaengt. */
  systemPrompt?: string;
  /** JSON-Schema fuer die strukturierte Ausgabe. */
  schema?: object;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs?: number;
  /** Harte Grenze fuer Assistant-Turns; der Runner bricht bei Ueberschreitung ab. */
  maxTurns?: number;
}

export interface RunOutcome {
  ok: boolean;
  output?: unknown;
  error?: string;
  text?: string;
  sessionId?: string;
  turns?: number;
  tokens?: { input: number; output: number };
}

export type RunEvent = { kind: "text" | "tool" | "info" | "usage"; text: string; context?: number };

export interface Runner {
  run(spec: RunSpec, onEvent?: (e: RunEvent) => void): Promise<RunOutcome>;
}
