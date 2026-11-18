/**
 * Abnahme Phase 4, Task 4: lokale Preview je Aufgabe.
 * Startet einen Mini-Server auf freiem Port, wartet auf Bereitschaft, beendet ihn sauber
 * und raeumt verwaiste Preview-Prozesse ueber PID-Dateien auf.
 * Prozessgruppen (setsid, SIGTERM an die Gruppe) gibt es nur unter Linux/WSL2;
 * unter Windows nativ sind diese Tests uebersprungen (WSL2-only).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStalePreviews, PreviewConfig, startPreview } from "../../packages/daemon/src/preview";

const POSIX = process.platform !== "win32";

function pidDir(): string {
  return mkdtempSync(join(tmpdir(), "usac-preview-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return !alive(pid);
}

describe("Lokale Preview", () => {
  test.skipIf(!POSIX)("Preview startet und ist erreichbar (WSL2-only)", async () => {
    const dir = pidDir();
    const cfg = PreviewConfig.parse({
      command: `bun -e "Bun.serve({port: Number(process.argv[1]), fetch: () => new Response('ok')})" {port}`,
      ready_timeout_ms: 15_000,
    });
    const p = await startPreview({ cwd: process.cwd(), cfg, env: {}, pidDir: dir, id: "t1" });
    try {
      expect(p.url).toBe(`http://127.0.0.1:${p.port}/`);
      expect(existsSync(join(dir, "t1.pid"))).toBe(true);
      const res = await fetch(p.url);
      expect(await res.text()).toBe("ok");
    } finally {
      await p.stop();
    }
    expect(existsSync(join(dir, "t1.pid"))).toBe(false);
    // Port wieder frei: zweites Listen auf denselben Port gelingt.
    const l = Bun.listen({ hostname: "127.0.0.1", port: p.port, socket: { data() {} } });
    expect(l.port).toBe(p.port);
    l.stop(true);
  }, 30_000);

  test.skipIf(!POSIX)("Timeout beendet den Prozess (WSL2-only)", async () => {
    const dir = pidDir();
    const cfg = PreviewConfig.parse({ command: `bun -e "setInterval(()=>{},1000)" {port}`, ready_timeout_ms: 1500 });
    let pid = 0;
    const err = await startPreview({ cwd: process.cwd(), cfg, env: {}, pidDir: dir, id: "t2" }).then(
      () => null,
      (e: Error & { pid?: number }) => {
        pid = e.pid ?? 0;
        return e;
      },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("nicht bereit");
    expect(pid).toBeGreaterThan(0);
    expect(await waitDead(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(dir, "t2.pid"))).toBe(false);
  }, 30_000);

  test.skipIf(!POSIX)("Waisen werden aufgeräumt (WSL2-only)", async () => {
    const dir = pidDir();
    const proc = Bun.spawn(["sh", "-c", `exec bun -e "setInterval(()=>{},1000)"`], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    writeFileSync(join(dir, "orphan.pid"), String(proc.pid));
    expect(alive(proc.pid)).toBe(true);
    expect(cleanupStalePreviews(dir)).toBe(1);
    expect(await waitDead(proc.pid)).toBe(true);
    expect(existsSync(join(dir, "orphan.pid"))).toBe(false);
  }, 30_000);

  test("Konfiguration ohne {port} ist ungültig", () => {
    expect(PreviewConfig.safeParse({ command: "bun run dev" }).success).toBe(false);
    const ok = PreviewConfig.parse({ command: "bun run dev --port {port}" });
    expect(ok.health_path).toBe("/");
    expect(ok.ready_timeout_ms).toBe(60_000);
  });
});
