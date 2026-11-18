/**
 * Lokale Preview je Aufgabe: startet den Dev-Server des Projekts auf einem freien Port,
 * wartet per HTTP-Abfrage auf Bereitschaft und beendet ihn wieder.
 * Der Prozess laeuft in eigener Prozessgruppe (Bun.spawn `detached` = setsid unter POSIX),
 * damit `stop` auch Kindprozesse des Shell-Befehls erreicht. PID-Dateien erlauben das
 * Aufraeumen verwaister Previews nach einem Daemon-Absturz.
 * Events (`preview.started`, `preview.stopped`, `preview.failed`) schreibt der Aufrufer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PreviewConfig = z.object({
  command: z.string().includes("{port}"),
  health_path: z.string().default("/"),
  ready_timeout_ms: z.number().int().positive().default(60_000),
});
export type PreviewConfig = z.infer<typeof PreviewConfig>;

export type Preview = { url: string; port: number; pid: number; stop(): Promise<void> };

const POLL_MS = 500;
const KILL_GRACE_MS = 3000;
const TAIL_LINES = 20;

/** Freien Port vom Betriebssystem holen (Listen auf Port 0, sofort wieder schliessen). */
function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal an die Prozessgruppe (POSIX), sonst an den Prozess selbst. */
function signal(pid: number, sig: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // keine Gruppe (z. B. nicht mit setsid gestartet): Einzelprozess versuchen
    }
  }
  try {
    process.kill(pid, sig);
  } catch {
    // bereits beendet
  }
}

/** SIGTERM, nach Frist SIGKILL; wartet, bis der Gruppenleiter weg ist. */
async function terminate(pid: number, exited: Promise<unknown>): Promise<void> {
  signal(pid, "SIGTERM");
  const done = await Promise.race([exited.then(() => true), Bun.sleep(KILL_GRACE_MS).then(() => false)]);
  // Auch nach Ende des Gruppenleiters koennen Kinder der Gruppe leben: SIGKILL an die Gruppe.
  signal(pid, "SIGKILL");
  if (!done) await exited;
}

/** Liest einen Ausgabestrom zeilenweise in einen begrenzten Puffer. */
async function collect(stream: ReadableStream<Uint8Array> | undefined, lines: string[]): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? "";
    for (const p of parts) {
      lines.push(p);
      if (lines.length > TAIL_LINES) lines.shift();
    }
  }
  if (rest) {
    lines.push(rest);
    if (lines.length > TAIL_LINES) lines.shift();
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(POLL_MS * 2) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status < 400;
  } catch {
    return false;
  }
}

export async function startPreview(opts: {
  cwd: string;
  cfg: PreviewConfig;
  env: Record<string, string>;
  pidDir: string;
  id: string;
}): Promise<Preview> {
  const { cwd, cfg, env, pidDir, id } = opts;
  const port = freePort();
  const cmd = cfg.command.replaceAll("{port}", String(port));
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    env: { ...process.env, ...env, PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const pid = proc.pid;
  mkdirSync(pidDir, { recursive: true });
  const pidFile = join(pidDir, `${id}.pid`);
  writeFileSync(pidFile, String(pid));

  const output: string[] = [];
  void collect(proc.stdout, output).catch(() => undefined);
  void collect(proc.stderr, output).catch(() => undefined);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminate(pid, proc.exited);
    rmSync(pidFile, { force: true });
  };

  const path = cfg.health_path.startsWith("/") ? cfg.health_path : `/${cfg.health_path}`;
  const url = `http://127.0.0.1:${port}${path}`;
  const start = Date.now();
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (Date.now() - start < cfg.ready_timeout_ms && !exited) {
    if (await healthy(url)) return { url, port, pid, stop };
    await Bun.sleep(POLL_MS);
  }

  await stop();
  const err = new Error(
    `Preview nicht bereit nach ${cfg.ready_timeout_ms} ms: ${output.slice(-TAIL_LINES).join("\n")}`,
  ) as Error & { pid: number };
  err.pid = pid;
  throw err;
}

/** Beendet Prozesse aus PID-Dateien in `pidDir` und loescht die Dateien. Gibt die Zahl beendeter Prozesse zurueck. */
export function cleanupStalePreviews(pidDir: string): number {
  if (!existsSync(pidDir)) return 0;
  let killed = 0;
  for (const name of readdirSync(pidDir)) {
    if (!name.endsWith(".pid")) continue;
    const file = join(pidDir, name);
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      // Verwaiste Preview: kein geordnetes Herunterfahren noetig, Gruppe sofort beenden.
      signal(pid, "SIGKILL");
      killed++;
    }
    rmSync(file, { force: true });
  }
  return killed;
}
