#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import type { Size, WorkItemType } from "@usac/shared";
import { sh } from "./exec";
import { excludeFromGit, hasGraphify, updateGraph } from "./graph";
import { createOrchestrator } from "./orchestrator";
import { ClaudeRunner } from "./runner/claude";
import { openStore } from "./store";

const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const HOME = process.env.USAC_HOME ?? join(homedir(), ".usac");

const HELP = `US-AGENTIC-CODE (usac)

  usac init [pfad]                         Projekt einrichten (.usac/project.yaml, Graphify)
  usac run <bugfix|feature> -t <titel> [-d <beschreibung>] [--size small] [--project .] [--auto h1,h2]
  usac resume <workitem-id>                Auftrag fortsetzen (z. B. nach Freigabe)
  usac status [workitem-id]                Auftraege und Status
  usac events <workitem-id> [--since n]    Event-Log eines Auftrags
  usac approve <freigabe-id> [--deny] [--note text]
  usac doctor                              Werkzeuge und Voraussetzungen pruefen
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
        },
      });
      const type = (positionals[0] ?? "bugfix") as WorkItemType;
      if (!values.title) throw new Error("Titel fehlt (-t)");
      const { orch } = orchestrator(values.auto ? values.auto.split(",") : []);
      const wi = await orch.submit({
        projectPath: resolve(values.project!),
        type,
        title: values.title,
        description: values.desc ?? "",
        size: values.size as Size,
      });
      console.log(`Auftrag ${wi.id} angelegt.`);
      printResult(await orch.run(wi.id), wi.id);
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
      console.log(`Freigabe ${positionals[0]} ${values.deny ? "abgelehnt" : "erteilt"}. Weiter mit: usac resume ${wiId}`);
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
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
