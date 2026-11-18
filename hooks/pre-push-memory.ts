#!/usr/bin/env bun
/**
 * Pre-Push-Hook: exportiert verified-Memory-Eintraege in das lokale Arbeitsverzeichnis
 * des privaten Repos usac-memory. Committet und pusht selbst nie.
 * Bricht (Exit 1) ab, wenn das Ziel nicht erreichbar ist.
 * Umgebung: USAC_MEMORY_DB (Default ~/.usac/memory.db), USAC_MEMORY_DIR (Pflicht, Klon von usac-memory).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exportVerified, openMemory } from "../packages/daemon/src/memory";

export interface HookOptions {
  dbPath: string;
  targetDir: string;
  isReachable?: (dir: string, git: (args: string[]) => number) => boolean;
  onGit?: (args: string[]) => void;
}

export function runPrePushMemory(o: HookOptions): { code: number; exported: number; message?: string } {
  // Nur lesende git-Aufrufe (ls-remote); nie commit/push.
  const git = (args: string[]): number => {
    o.onGit?.(args);
    return Bun.spawnSync(["git", "-C", o.targetDir, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode;
  };
  const reachable = (o.isReachable ?? ((d, g) => existsSync(d) && g(["ls-remote", "--exit-code", "origin", "HEAD"]) === 0))(o.targetDir, git);
  if (!reachable) return { code: 1, exported: 0, message: `usac-memory nicht erreichbar: ${o.targetDir}` };
  const db = openMemory(o.dbPath);
  try {
    return { code: 0, exported: exportVerified(db, o.targetDir) };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const targetDir = process.env.USAC_MEMORY_DIR;
  if (!targetDir) {
    console.error("USAC_MEMORY_DIR fehlt");
    process.exit(1);
  }
  const r = runPrePushMemory({ dbPath: process.env.USAC_MEMORY_DB ?? join(homedir(), ".usac", "memory.db"), targetDir });
  if (r.message) console.error(r.message);
  else console.log(`${r.exported} verified-Eintraege exportiert (nicht committet)`);
  process.exit(r.code);
}
