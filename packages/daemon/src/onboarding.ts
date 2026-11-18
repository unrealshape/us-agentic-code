import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ExplorerOutput, type Actor, type Claim, type FileEvidence, type WorkItemStatus } from "@usac/shared";
import { ProjectProfile, type ProfileProposal } from "./config";
import { detectStacks } from "./detect";
import { validateClaims, type EvidenceContext } from "./evidence";
import { git } from "./exec";
import { addEntry, checkMemoryEvidence, openMemory, verifyEntry } from "./memory";
import { GRAPH_NOTE, PRECISION_RULES, rolePrompt, roleSchema } from "./prompts";
import { loadRouting, resolveModel } from "./routing";
import type { Runner } from "./runner/types";
import type { Store, WorkItem } from "./store";

/**
 * Onboarding-Run: fester Ablauf im Code (detect -> explore -> Freigabe `profile` -> write_profile).
 * Der Explorer liest den Projektordner nur; das Profil schreibt ausschliesslich dieser Code,
 * und erst nach Bestaetigung durch den Nutzer.
 */

/** Explorer-Versuche je Erkundung (ungueltige Ausgabe oder Belege zaehlen als Fehlversuch). */
export const EXPLORE_ATTEMPTS = 2;
/** So oft fuehrt eine Ablehnung mit Notiz zu einer neuen Erkundung; danach Eskalation. */
export const MAX_REJECTIONS = 1;
const MAX_TURNS = 60;
const RUN_TIMEOUT_MS = 20 * 60_000;
/** Der Explorer aendert nichts: Schreibwerkzeuge sind gesperrt. */
const READ_ONLY_DENY = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

type Stack = { profile: string; files: number };
type OnboardingState = {
  phase: "explore" | "approve" | "done";
  stacks: Stack[];
  rejections: number;
  feedback?: string;
  approvalId?: number;
  proposal?: ProfileProposal;
  /** Angenommene Konventionen mit ihren Datei-Belegen (fuer das Memory nach der Bestaetigung). */
  conventions?: { text: string; evidence: FileEvidence[] }[];
};

class Escalate extends Error {}

export interface OnboardingOptions {
  store: Store;
  runner: Runner;
  pluginRoot: string;
  memoryPath: string;
}

export function createOnboarding(opts: OnboardingOptions) {
  const { store, runner, pluginRoot, memoryPath } = opts;
  const routing = loadRouting(pluginRoot);

  const profilePath = (projectPath: string) => join(projectPath, ".usac", "project.yaml");

  function emit(wi: WorkItem, type: string, data: unknown = {}, spanId = wi.id, actor: Actor = "orchestrator") {
    store.append({ traceId: wi.id, spanId, parentSpanId: spanId === wi.id ? null : wi.id, project: basename(wi.projectPath), type, actor, data });
  }

  const state = (wi: WorkItem) => wi.state as OnboardingState;

  function save(wi: WorkItem, patch: Partial<OnboardingState>, status?: WorkItemStatus): WorkItem {
    store.updateWorkItem(wi.id, { state: { ...state(wi), ...patch }, ...(status ? { status } : {}) });
    return store.getWorkItem(wi.id)!;
  }

  function withMemory<T>(fn: (db: ReturnType<typeof openMemory>) => T): T {
    const db = openMemory(memoryPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** Standard-Branch: `origin/HEAD` ohne `origin/`, sonst der aktuelle Branch. */
  async function baseBranch(cwd: string): Promise<string> {
    try {
      const ref = (await git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).trim();
      if (ref) return ref.replace(/^origin\//, "");
    } catch {
      // kein origin/HEAD
    }
    try {
      const cur = (await git(cwd, "branch", "--show-current")).trim();
      if (cur) return cur;
    } catch {
      // kein Branch lesbar
    }
    return "main";
  }

  function explorerPrompt(stacks: Stack[], feedback?: string, withGraph = false): string {
    return [
      `Auftrag (onboarding): Lerne das Projekt im aktuellen Ordner kennen und liefere die Grundlage fuer sein Projektprofil. Du aenderst keine Dateien.`,
      `Erkannte Stacks (Dateien je Gate-Profil): ${stacks.map((s) => `${s.profile} (${s.files})`).join(", ")}`,
      `Liefere:
- languages: die Sprachen des Projekts.
- commands: build, test, lint, format, jeweils nur, wenn der Befehl im Projekt belegt ist (Konfiguration, Skript, Doku).
- conventions: hoechstens 10 Konventionen; jede mit Datei-Beleg (path, lines, woertliches quote). Ohne Beleg: Stufe UNKNOWN und eine Frage in questions.`,
      feedback ? `Rueckmeldung zum letzten Versuch:\n${feedback}` : "",
      withGraph ? GRAPH_NOTE : "",
      PRECISION_RULES,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Ein Explorer-Lauf mit Schema- und Belegpruefung. */
  async function runExplorer(wi: WorkItem, failures: number, feedback?: string): Promise<{ ok: true; output: ExplorerOutput } | { ok: false; feedback: string }> {
    const route = resolveModel(routing, "explorer", { failures });
    const spanId = `run_${randomBytes(5).toString("hex")}`;
    const actor: Actor = "role:explorer";
    emit(wi, "run.started", { role: "explorer", model: route.model }, spanId, actor);
    const withGraph = existsSync(join(wi.projectPath, "graphify-out", "graph.json"));
    const outcome = await runner.run(
      {
        role: "explorer",
        model: route.model,
        prompt: explorerPrompt(state(wi).stacks, feedback, withGraph),
        cwd: wi.projectPath,
        systemPrompt: rolePrompt(pluginRoot, "explorer"),
        schema: roleSchema(pluginRoot, "explorer"),
        disallowedTools: READ_ONLY_DENY,
        maxTurns: MAX_TURNS,
        timeoutMs: RUN_TIMEOUT_MS,
        env: { USAC_WORK_ITEM: wi.id, USAC_PROTECTOR_MODE: "blockieren" },
      },
      (e) => {
        if (e.kind !== "usage") emit(wi, "run.output", e, spanId, actor);
      },
    );
    emit(wi, "run.finished", { role: "explorer", model: route.model, ok: outcome.ok, error: outcome.error, turns: outcome.turns, tokens: outcome.tokens }, spanId, actor);
    if (!outcome.ok) return { ok: false, feedback: `Die Session ist fehlgeschlagen: ${outcome.error}` };

    const parsed = ExplorerOutput.safeParse(outcome.output);
    if (!parsed.success) {
      emit(wi, "output.invalid", { role: "explorer", issues: parsed.error.issues.slice(0, 10) }, spanId);
      return { ok: false, feedback: `Deine Ausgabe entsprach nicht dem Schema: ${parsed.error.message.slice(0, 1500)}` };
    }
    const ctx: EvidenceContext = {
      cwd: wi.projectPath,
      store,
      workItemId: wi.id,
      memory: { check: (id, cwd) => withMemory((db) => checkMemoryEvidence(db, id, cwd)) },
    };
    const errors = validateClaims([...parsed.data.conventions, ...parsed.data.claims], ctx);
    if (errors.length) {
      emit(wi, "evidence.invalid", { role: "explorer", errors }, spanId);
      return { ok: false, feedback: `Belege ungueltig:\n${errors.map((e) => `- "${e.claim}": ${e.problem}`).join("\n")}` };
    }
    return { ok: true, output: parsed.data };
  }

  /** Konvention zaehlt nur als Fakt (VERIFIED/EXTRACTED) mit mindestens einem Datei-Beleg. */
  function acceptedConventions(conventions: Claim[]): { text: string; evidence: FileEvidence[] }[] {
    return conventions
      .filter((c) => c.level === "VERIFIED" || c.level === "EXTRACTED")
      .map((c) => ({ text: c.text, evidence: c.evidence.filter((e): e is FileEvidence => e.type === "file") }))
      .filter((c) => c.evidence.length > 0);
  }

  /** Erkundet das Projekt und legt den Vorschlag als Freigabe `profile` vor. */
  async function explore(wi: WorkItem, feedback?: string): Promise<WorkItem> {
    wi = save(wi, { phase: "explore", feedback }, "running");
    let last = feedback;
    for (let attempt = 1; attempt <= EXPLORE_ATTEMPTS; attempt++) {
      const res = await runExplorer(wi, attempt - 1, last);
      if (!res.ok) {
        last = feedback ? `${feedback}\n\n${res.feedback}` : res.feedback;
        continue;
      }
      const out = res.output;
      const s = state(wi);
      const conventions = acceptedConventions(out.conventions);
      const commands = Object.fromEntries(Object.entries(out.commands).filter(([, v]) => typeof v === "string" && v.trim()));
      const profile = ProjectProfile.parse({
        name: basename(wi.projectPath),
        languages: out.languages.length ? out.languages : s.stacks.map((x) => x.profile),
        gate_profile: s.stacks[0]!.profile,
        base_branch: await baseBranch(wi.projectPath),
        ...(Object.keys(commands).length ? { commands } : {}),
      });
      const proposal: ProfileProposal = { ...profile, conventions: conventions.map((c) => c.text) };
      const approval = store.createApproval(wi.id, "profile", proposal);
      wi = save(wi, { phase: "approve", approvalId: approval.id, proposal, conventions }, "awaiting_approval");
      emit(wi, "onboarding.proposed", { proposal });
      emit(wi, "approval.requested", { approval_id: approval.id, kind: "profile" });
      return wi;
    }
    throw new Escalate(`Explorer lieferte nach ${EXPLORE_ATTEMPTS} Versuchen keine gueltige Ausgabe`);
  }

  /** Schreibt das bestaetigte Profil und legt die Konventionen verifiziert im Memory ab. */
  function writeProfile(wi: WorkItem): WorkItem {
    const s = state(wi);
    const { conventions: _texts, ...rest } = s.proposal!;
    const profile = ProjectProfile.parse({ ...rest, confirmed_at: new Date().toISOString() });
    const path = profilePath(wi.projectPath);
    mkdirSync(join(wi.projectPath, ".usac"), { recursive: true });
    writeFileSync(path, `# Projektprofil, erzeugt vom Onboarding (${wi.id}) und vom Nutzer bestaetigt.\n${stringifyYaml(profile)}`);
    withMemory((db) => {
      for (const c of s.conventions ?? []) {
        try {
          const id = addEntry(db, {
            kind: "convention",
            text: c.text,
            evidence: c.evidence.map((e) => ({ file: e.path, lines: e.lines[0] === e.lines[1] ? `${e.lines[0]}` : `${e.lines[0]}-${e.lines[1]}`, quote: e.quote })),
          });
          const verified = verifyEntry(db, id, wi.projectPath);
          emit(wi, "onboarding.convention", { text: c.text, status: verified ? "verified" : "proposed" });
        } catch (err) {
          emit(wi, "onboarding.convention_rejected", { text: c.text, reason: (err as Error).message });
        }
      }
    });
    emit(wi, "onboarding.written", { path });
    wi = save(wi, { phase: "done" }, "done");
    emit(wi, "workitem.done", {});
    return wi;
  }

  async function guarded(wi: WorkItem, step: (wi: WorkItem) => Promise<WorkItem>): Promise<WorkItem> {
    try {
      return await step(wi);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const status: WorkItemStatus = err instanceof Escalate ? "escalated" : "failed";
      const cur = store.getWorkItem(wi.id)!;
      store.updateWorkItem(cur.id, { status });
      emit(cur, status === "escalated" ? "workitem.escalated" : "workitem.failed", { reason, phase: state(cur).phase });
      return store.getWorkItem(cur.id)!;
    }
  }

  return {
    async start(projectPath: string, force = false): Promise<{ workItemId: string; status: WorkItemStatus; approvalId?: number }> {
      const existing = profilePath(projectPath);
      if (existsSync(existing) && !force) {
        throw new Error(`Projektprofil existiert bereits: ${existing}. Mit --force neu erkunden; ueberschrieben wird erst nach Bestaetigung.`);
      }
      const id = `wi_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      let wi = store.createWorkItem({
        id,
        projectPath,
        type: "onboarding",
        title: `Onboarding ${basename(projectPath)}`,
        description: "Projekt kennenlernen und Projektprofil zur Bestaetigung vorschlagen",
        size: "small",
      });
      emit(wi, "workitem.created", { type: "onboarding", title: wi.title, project: basename(projectPath), force });
      wi = await guarded(wi, async (w) => {
        const stacks = detectStacks(projectPath, pluginRoot);
        w = save(w, { phase: "explore", stacks, rejections: 0 }, "running");
        emit(w, "onboarding.detected", { stacks });
        if (stacks.length === 0) throw new Escalate("Kein Stack erkannt: kein Gate-Profil passt auf die Dateien des Projekts");
        return explore(w);
      });
      return { workItemId: wi.id, status: wi.status, approvalId: wi.status === "awaiting_approval" ? state(wi).approvalId : undefined };
    },

    async resume(workItemId: string): Promise<{ status: WorkItemStatus }> {
      let wi = store.getWorkItem(workItemId);
      if (!wi) throw new Error(`WorkItem ${workItemId} nicht gefunden`);
      if (wi.type !== "onboarding") throw new Error(`WorkItem ${workItemId} ist kein Onboarding (${wi.type})`);
      if (wi.status === "done" || wi.status === "escalated" || wi.status === "failed") return { status: wi.status };
      const s = state(wi);
      if (s.phase === "explore") return { status: (await guarded(wi, (w) => explore(w, s.feedback))).status };

      const approval = s.approvalId ? store.getApproval(s.approvalId) : null;
      if (!approval) throw new Error(`Freigabe zu ${workItemId} fehlt`);
      if (approval.status === "pending") {
        if (wi.status !== "awaiting_approval") wi = save(wi, {}, "awaiting_approval");
        return { status: "awaiting_approval" };
      }
      if (approval.status === "granted") {
        emit(wi, "approval.granted", { approval_id: approval.id, kind: "profile" });
        return { status: (await guarded(wi, async (w) => writeProfile(w))).status };
      }

      emit(wi, "approval.denied", { approval_id: approval.id, kind: "profile", note: approval.note });
      const note = approval.note?.trim();
      wi = await guarded(wi, async (w) => {
        if (!note) throw new Escalate("Profilvorschlag ohne Notiz abgelehnt");
        if ((s.rejections ?? 0) >= MAX_REJECTIONS) throw new Escalate(`Profilvorschlag ${s.rejections + 1}-mal abgelehnt: ${note}`);
        w = save(w, { rejections: (s.rejections ?? 0) + 1 });
        emit(w, "onboarding.rejected", { approval_id: approval.id, note });
        return explore(w, `Der Nutzer hat den Profilvorschlag abgelehnt. Notiz: ${note}`);
      });
      return { status: wi.status };
    },
  };
}

export type Onboarding = ReturnType<typeof createOnboarding>;
