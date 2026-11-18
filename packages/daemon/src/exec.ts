export interface ExecResult {
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_OUTPUT = 20_000;

/** Fuehrt einen Shell-Befehl aus und sammelt stdout+stderr (gekuerzt). */
export async function sh(command: string, cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  let output = (out + (err ? `\n${err}` : "")).trim();
  if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + "\n[... gekuerzt]";
  return { exitCode: timedOut ? 124 : exitCode, output, durationMs: Date.now() - started, timedOut };
}

/**
 * Git-Aufruf, wirft bei Fehler.
 * core.autocrlf=false erzwingen: Unter Windows wuerde Git beim Checkout CRLF schreiben,
 * und die Hashes gesperrter Abnahmetests (LF) stimmten danach nicht mehr.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "core.autocrlf=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} fehlgeschlagen (${code}): ${err.trim()}`);
  return out.trim();
}
