import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunOutcome, RunSpec, Runner } from "./types";

export interface ClaudeRunnerOptions {
  /** Pfad zum claude-Binary. */
  bin?: string;
  /** Plugin-Verzeichnis, damit Hooks (Protector, Delivery-Gate) in jeder Session aktiv sind. */
  pluginDir?: string;
  /** Eingebaute Bash-Sandbox einschalten (Linux/WSL2: bubblewrap + socat). */
  sandbox?: boolean;
}

/**
 * Macht aus einem Arbeitsverzeichnis einen Permission-Pfad mit "//"-Praefix (absolut).
 * POSIX: /tmp/wt -> //tmp/wt. Windows: C:\proj -> //C:/proj (Backslashes werden zu Slashes).
 */
export function toRulePath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/^\/+/, "");
  return `//${normalized}`;
}

/** Erzeugt die Settings-Datei je Run: Sandbox fuer Bash, Schreibrechte nur im Worktree. */
export function buildSettings(spec: RunSpec, sandbox: boolean): object {
  const root = toRulePath(spec.cwd);
  return {
    sandbox: sandbox ? { enabled: true, autoAllowBashIfSandboxed: true } : { enabled: false },
    permissions: {
      allow: [`Edit(${root}/**)`, `Write(${root}/**)`],
      deny: ["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(**/.env)", "Read(**/.env.*)", "Edit(**/.env)", "Write(**/.env)"],
    },
  };
}

export function buildArgs(spec: RunSpec, settingsPath: string, opts: ClaudeRunnerOptions = {}): string[] {
  const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", "--model", spec.model];
  args.push("--settings", settingsPath, "--permission-mode", "acceptEdits");
  if (spec.systemPrompt) args.push("--append-system-prompt", spec.systemPrompt);
  if (spec.schema) args.push("--json-schema", JSON.stringify(spec.schema));
  if (spec.allowedTools?.length) args.push("--allowedTools", ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push("--disallowedTools", ...spec.disallowedTools);
  if (opts.pluginDir) args.push("--plugin-dir", opts.pluginDir);
  return args;
}

/** Startet eine echte Claude-Code-Session ueber das Abo (claude -p). */
export class ClaudeRunner implements Runner {
  constructor(private opts: ClaudeRunnerOptions = {}) {}

  async run(spec: RunSpec, onEvent?: (e: RunEvent) => void): Promise<RunOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "usac-run-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(buildSettings(spec, this.opts.sandbox ?? true), null, 2));
    const args = buildArgs(spec, settingsPath, this.opts);

    const proc = Bun.spawn([this.opts.bin ?? "claude", ...args], {
      cwd: spec.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    let turns = 0;
    let killedReason: string | null = null;
    const timer = setTimeout(() => {
      killedReason = `Zeitlimit ${spec.timeoutMs} ms ueberschritten`;
      proc.kill();
    }, spec.timeoutMs ?? 15 * 60_000);

    let result: Record<string, any> | null = null;
    let sessionId: string | undefined;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === "assistant") {
          turns += 1;
          for (const part of msg.message?.content ?? []) {
            if (part.type === "text") onEvent?.({ kind: "text", text: String(part.text).slice(0, 2000) });
            if (part.type === "tool_use") onEvent?.({ kind: "tool", text: `${part.name} ${JSON.stringify(part.input).slice(0, 500)}` });
          }
          if (spec.maxTurns && turns > spec.maxTurns && !killedReason) {
            killedReason = `Turn-Limit ${spec.maxTurns} ueberschritten`;
            proc.kill();
          }
        }
        if (msg.type === "result") result = msg;
      }
    }
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stderr = await new Response(proc.stderr).text();

    if (killedReason) return { ok: false, error: killedReason, turns, sessionId };
    if (!result) return { ok: false, error: `claude beendet ohne Ergebnis (Exit ${exitCode}): ${stderr.slice(0, 1000)}`, turns, sessionId };
    if (result.is_error || (result.subtype && result.subtype !== "success")) {
      return { ok: false, error: `claude-Fehler: ${result.subtype ?? ""} ${String(result.result ?? "").slice(0, 1000)}`, turns, sessionId };
    }
    // Mit --json-schema liefert die CLI die strukturierte Ausgabe; sonst versuchen wir, den Text zu parsen.
    let output: unknown = result.structured_output;
    if (output === undefined && typeof result.result === "string") {
      output = parseJsonLoose(result.result);
    }
    return {
      ok: output !== undefined,
      output,
      error: output === undefined ? "Keine strukturierte Ausgabe erhalten" : undefined,
      text: typeof result.result === "string" ? result.result : undefined,
      sessionId,
      turns,
      tokens: { input: result.usage?.input_tokens ?? 0, output: result.usage?.output_tokens ?? 0 },
    };
  }
}

export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    if (m) {
      try {
        return JSON.parse(m[1]!);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
