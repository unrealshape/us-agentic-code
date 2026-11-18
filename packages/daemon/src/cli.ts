#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import type { Size, WorkItemType } from "@usac/shared";
import { sh } from "./exec";
import { excludeFromGit, hasGraphify, updateGraph } from "./graph";
import { createOrchestrator } from "./orchestrator";
import "./registry-setup";
import { ClaudeRunner } from "./runner/claude";
import { ensureLeaseSchema } from "./leases";
import { MAX_PARALLEL, createScheduler } from "./scheduler";
import { openStore } from "./store";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const HOME = process.env.USAC_HOME ?? join(homedir(), ".usac");

/** Takt der Scheduler-Schleife von `usac daemon` (offene Entscheidung 9 im Plan). */
const DAEMON_TICK_MS = 1_000;

/** Typen fuer `usac run` (onboarding hat einen eigenen Ablauf). */
const RUN_TYPES: WorkItemType[] = ["bugfix", "feature", "change", "refactor", "new-project", "dependency-update", "security-fix", "spike"];

/** Freigaben, die per --auto automatisch erteilt werden duerfen (H2 nie). */
const AUTO_ALLOWED = ["h1", "spec"];

const HELP = `US-AGENTIC-CODE (usac)

  usac init [pfad]                         Projekt einrichten (.usac/project.yaml, Graphify)
  usac new-project <ordner> --stack <profil>  Ordner, git init, .usac/project.yaml und ersten Commit anlegen
                                           (kein GitHub-Remote; das richtest du selbst ein)
  usac run <typ> -t <titel> [-d <beschreibung>] [--size small] [--project .] [--auto h1,spec] [--queue]
                                           <typ>: bugfix, feature, change, refactor, new-project,
                                           dependency-update, security-fix, spike
                                           --auto spec wirkt nur, wenn die Spec keine offenen Fragen hat
                                           --queue reiht nur ein; usac daemon fuehrt aus
  usac resume <workitem-id>                Auftrag fortsetzen (z. B. nach Freigabe)
  usac status [workitem-id]                Auftraege und Status
  usac events <workitem-id> [--since n]    Event-Log eines Auftrags
  usac approve <freigabe-id> [--deny] [--note text]
  usac daemon [--parallel 3]               Scheduler-Schleife: wartende Auftraege starten (Takt 1 s)
  usac leases                              Datei-Leases (Pfad, Halter, Alter)
  usac doctor                              Werkzeuge und Voraussetzungen pruefen
  usac ui [--port 7777]                    UI (Inbox, Agent-Wand, Run-Detail) auf 127.0.0.1 starten
`;

function orchestrator(auto: string[] = []) {
  const store = openStore(join(HOME, "usac.db"));
  const runner = new ClaudeRunner({
    bin: process.env.USAC_CLAUDE_BIN,
    pluginDir: PLUGIN_ROOT,
    sandbox: process.env.USAC_SANDBOX !== "0",
  });
  return { store, orch: createOrchestrator({ store, runner, pluginRoot: PLUGIN_ROOT, home: HOME, approvals: { auto } }) };
}

function printResult(r: { status: string; branch: string | null; reason?: string }, id: string) {
  console.log(`Auftrag ${id}: ${r.status}${r.branch ? ` (Branch ${r.branch})` : ""}${r.reason ? `\nGrund: ${r.reason}` : ""}`);
  if (r.status === "awaiting_approval") console.log(`Offene Freigaben: usac status ${id}`);
}

async function detectLanguages(dir: string): Promise<string[]> {
  const langs: string[] = [];
  const has = async (pattern: string) => {
    for await (const _ of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true })) return true;
    return false;
  };
  if (await has("**/*.lua")) langs.push("lua");
  if ((await has("**/*.ts")) || existsSync(join(dir, "tsconfig.json"))) langs.push("typescript");
  if (await has("**/*.py")) langs.push("python");
  return langs;
}

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  switch (cmd) {
    case "init": {
      const dir = resolve(rest[0] ?? ".");
      const langs = await detectLanguages(dir);
      const profilePath = join(dir, ".usac/project.yaml");
      if (!existsSync(profilePath)) {
        const gate = langs.find((l) => existsSync(join(PLUGIN_ROOT, "gate-profiles", `${l}.yaml`)));
        if (!gate) {
          console.error(`Kein Gate-Profil fuer erkannte Sprachen (${langs.join(", ") || "keine"}). Lege eins unter gate-profiles/ an.`);
          process.exit(1);
        }
        mkdirSync(join(dir, ".usac"), { recursive: true });
        writeFileSync(profilePath, stringify({ name: basename(dir), languages: langs, gate_profile: gate, base_branch: "main" }));
        console.log(`Projektprofil angelegt: ${profilePath} (Sprachen: ${langs.join(", ")}, Gate-Profil: ${gate})`);
      } else console.log(`Projektprofil vorhanden: ${profilePath}`);
      await excludeFromGit(dir, ["graphify-out/"]);
      if (await hasGraphify()) {
        const g = await updateGraph(dir);
        console.log(g.ok ? `Graphify: ${g.nodes} Knoten, ${g.edges} Kanten` : `Graphify fehlgeschlagen:\n${g.output}`);
      } else console.log("Graphify nicht installiert (usac doctor)");
      break;
    }
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          title: { type: "string", short: "t" },
          desc: { type: "string", short: "d", default: "" },
          size: { type: "string", default: "small" },
          project: { type: "string", default: "." },
          auto: { type: "string", default: "" },
          queue: { type: "boolean", default: false },
        },
      });
      const type = (positionals[0] ?? "bugfix") as WorkItemType;
      if (!RUN_TYPES.includes(type)) throw new Error(`Unbekannter Typ "${type}". Erlaubt: ${RUN_TYPES.join(", ")}`);
      if (!values.title) throw new Error("Titel fehlt (-t)");
      const auto = values.auto ? values.auto.split(",").map((a) => a.trim()) : [];
      // H2 (Merge in die Basis) erteilt immer ein Mensch.
      if (auto.includes("h2")) throw new Error("--auto h2 ist nicht erlaubt: Die Freigabe H2 vor dem Merge erteilt immer ein Mensch (usac approve).");
      const unknown = auto.filter((a) => !AUTO_ALLOWED.includes(a));
      if (unknown.length) throw new Error(`--auto erlaubt nur ${AUTO_ALLOWED.join(", ")} (unbekannt: ${unknown.join(", ")})`);
      const { store, orch } = orchestrator(auto);
      const wi = await orch.submit({
        projectPath: resolve(values.project!),
        type,
        title: values.title,
        description: values.desc ?? "",
        size: values.size as Size,
      });
      console.log(`Auftrag ${wi.id} angelegt.`);
      if (values.queue) {
        store.append({ traceId: wi.id, spanId: wi.id, parentSpanId: null, project: basename(wi.projectPath), type: "workitem.queued", actor: "orchestrator", data: { reason: "cli" } });
        console.log(`Auftrag ${wi.id}: queued (startet mit usac daemon)`);
        break;
      }
      printResult(await orch.run(wi.id), wi.id);
      break;
    }
    case "new-project": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { stack: { type: "string" } } });
      if (!positionals[0]) throw new Error("Ordner fehlt: usac new-project <ordner> --stack <profil>");
      const stacks = readdirSync(join(PLUGIN_ROOT, "gate-profiles"))
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.slice(0, -5));
      if (!values.stack || !stacks.includes(values.stack)) {
        throw new Error(`--stack fehlt oder ist unbekannt (${values.stack ?? "-"}). Erlaubt: ${stacks.join(", ")}`);
      }
      const dir = resolve(positionals[0]);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`Ordner ${dir} existiert und ist nicht leer`);
      mkdirSync(join(dir, ".usac"), { recursive: true });
      const name = basename(dir);
      writeFileSync(join(dir, ".usac/project.yaml"), stringify({ name, languages: [values.stack], gate_profile: values.stack, base_branch: "main" }));
      const run = async (cmd: string) => {
        const r = await sh(cmd, dir, 30_000);
        if (r.exitCode !== 0) throw new Error(`${cmd} fehlgeschlagen (${r.exitCode}): ${r.output}`);
        return r.output;
      };
      await run("git init -q -b main");
      await run("git add -A");
      // Ohne konfigurierte Git-Identitaet committet usac unter eigenem Namen (wie der Orchestrator).
      const identity = (await sh("git config user.email", dir, 10_000)).exitCode === 0 ? "" : "-c user.name=US-AGENTIC-CODE -c user.email=usac@localhost ";
      await run(`git ${identity}commit -q -m "chore: Projekt angelegt"`);
      console.log(`Projekt angelegt: ${dir} (Gate-Profil ${values.stack}, Branch main, ohne Remote)`);
      console.log(`Weiter mit: usac run new-project -t <titel> --project ${dir}`);
      break;
    }
    case "resume": {
      const id = rest[0];
      if (!id) throw new Error("WorkItem-ID fehlt");
      const { orch } = orchestrator();
      printResult(await orch.run(id), id);
      break;
    }
    case "status": {
      const { store } = orchestrator();
      const items = rest[0] ? [store.getWorkItem(rest[0])].filter(Boolean) : store.listWorkItems();
      for (const wi of items) console.log(`${wi!.id}  ${wi!.status.padEnd(18)} ${wi!.type.padEnd(8)} ${wi!.title}`);
      for (const a of store.pendingApprovals().filter((a) => !rest[0] || a.workItemId === rest[0])) {
        console.log(`  Freigabe ${a.id} (${a.kind}) wartet: ${JSON.stringify(a.context)}`);
      }
      if (rest[0]) {
        // Kontext-Ueberblick: Spitze je Run gegen das Limit, Ueberschreitungen als Warnung.
        const evs = store.events({ traceId: rest[0] });
        for (const e of evs.filter((e) => e.type === "run.finished")) {
          const d = e.data as { role: string; model: string; peak_context?: number; context_limit?: number };
          if (d.peak_context === undefined) continue;
          console.log(`  Kontext ${d.role} (${d.model}): Spitze ${d.peak_context} / ${d.context_limit} Tokens`);
        }
        for (const e of evs.filter((e) => e.type === "budget.exceeded")) {
          const d = e.data as { role: string; context: number; limit: number };
          console.log(`  WARNUNG Kontext-Limit ueberschritten: ${d.role} bei ${d.context} Tokens (Limit ${d.limit}); Auto-Compact greift.`);
        }
      }
      break;
    }
    case "events": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { since: { type: "string" } } });
      const { store } = orchestrator();
      for (const e of store.events({ traceId: positionals[0], sinceId: values.since ? Number(values.since) : undefined })) {
        console.log(`${String(e.id).padStart(5)} ${e.ts.slice(11, 19)} ${e.type.padEnd(22)} ${e.actor.padEnd(22)} ${JSON.stringify(e.data).slice(0, 160)}`);
      }
      break;
    }
    case "approve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { deny: { type: "boolean", default: false }, note: { type: "string" } },
      });
      const { orch } = orchestrator();
      const wiId = orch.approve(Number(positionals[0]), !values.deny, values.note);
      console.log(`Freigabe ${positionals[0]} ${values.deny ? "abgelehnt" : "erteilt"}. Weiter mit: usac resume ${wiId} (oder laufender usac daemon)`);
      break;
    }
    case "daemon": {
      const { values } = parseArgs({ args: rest, options: { parallel: { type: "string", default: String(MAX_PARALLEL) } } });
      const max = Number(values.parallel);
      if (!Number.isInteger(max) || max < 1) throw new Error(`--parallel braucht eine ganze Zahl >= 1 (war: ${values.parallel})`);
      const { store, orch } = orchestrator();
      const sched = createScheduler({ store, run: (id) => orch.run(id, { slotHeld: true }), maxParallel: max });
      let stopping = false;
      let busy = false;
      const loop = setInterval(async () => {
        if (stopping || busy) return;
        busy = true;
        try {
          for (const id of await sched.tick()) console.log(`Auftrag ${id} gestartet`);
        } catch (err) {
          console.error(`Takt fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busy = false;
        }
      }, DAEMON_TICK_MS);
      // Erstes Ctrl+C: keine neuen Auftraege, laufende zu Ende fuehren. Zweites: sofort beenden.
      process.on("SIGINT", async () => {
        if (stopping) process.exit(130);
        stopping = true;
        clearInterval(loop);
        console.log("Daemon stoppt; warte auf laufende Auftraege (erneut Ctrl+C bricht ab).");
        await sched.idle();
        process.exit(0);
      });
      console.log(`Daemon läuft (bis zu ${max} parallel, Takt ${DAEMON_TICK_MS} ms). Beenden mit Ctrl+C.`);
      break;
    }
    case "leases": {
      const { store } = orchestrator();
      ensureLeaseSchema(store);
      const rows = store.db
        .query("SELECT project, path, work_item_id, acquired_at FROM leases ORDER BY project, path")
        .all() as { project: string; path: string; work_item_id: string; acquired_at: number }[];
      if (!rows.length) {
        console.log("Keine Leases.");
        break;
      }
      const now = Date.now();
      console.log(`${"Pfad".padEnd(40)} ${"Halter".padEnd(24)} Alter`);
      for (const r of rows) {
        const age = Math.max(0, Math.round((now - r.acquired_at) / 1000));
        console.log(`${`${basename(r.project)}:${r.path}`.padEnd(40)} ${r.work_item_id.padEnd(24)} ${age} s`);
      }
      break;
    }
    case "doctor": {
      const checks: Array<[string, string, boolean]> = [
        ["bun", "bun --version", true],
        ["git", "git --version", true],
        ["claude", "claude --version", true],
        ["gh", "gh --version", false],
        ["python3 (fuer Graphify)", "python3 --version", true],
        ["graphify", "graphify --help >/dev/null && echo ok", true],
        ["bubblewrap (Sandbox)", "bwrap --version", process.platform === "linux"],
        ["socat (Sandbox)", "socat -V | head -1", process.platform === "linux"],
        ["lua", "lua -v || lua5.4 -v", false],
        ["busted", "busted --version", false],
        ["luacheck", "luacheck --version", false],
      ];
      let missing = 0;
      for (const [name, cmd2, required] of checks) {
        const r = await sh(cmd2, process.cwd(), 15_000);
        const ok = r.exitCode === 0;
        if (!ok && required) missing++;
        console.log(`${ok ? "ok  " : required ? "FEHLT" : "--  "} ${name}${ok ? `: ${r.output.split("\n")[0]}` : ""}`);
      }
      const token = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
      console.log(`${token ? "ok  " : "--  "} CLAUDE_CODE_OAUTH_TOKEN ${token ? "gesetzt" : "nicht gesetzt (claude setup-token, oder interaktiv angemeldet)"}`);
      console.log(missing ? `\n${missing} Pflicht-Werkzeug(e) fehlen.` : "\nAlles bereit.");
      process.exit(missing ? 1 : 0);
    }
    case "ui": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string", default: "7777" } } });
      const { startServer } = await import("../../ui/src/server");
      const server = startServer(openStore(join(HOME, "usac.db")), { port: Number(values.port) });
      console.log(`UI laeuft: http://127.0.0.1:${server.port}/`);
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
