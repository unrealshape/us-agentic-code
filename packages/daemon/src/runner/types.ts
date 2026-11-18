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
  /** Hosts, die Bash-Befehle in der Sandbox erreichen duerfen (ADR 0005). Leer oder fehlend: kein Netz. */
  networkAllow?: string[];
  /** Zusaetzliche Umgebungsvariablen fuer die Session und ihre Hooks (z. B. USAC_HOOK_LOG). */
  env?: Record<string, string>;
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
