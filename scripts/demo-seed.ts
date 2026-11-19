// Befuellt eine Demo-Datenbank fuer die UI (nur zum Ansehen und Klicken, keine echten Auftraege).
// Aufruf: bun scripts/demo-seed.ts <pfad-zur-demo.db>
import { openStore } from "../packages/daemon/src/store";

const path = process.argv[2];
if (!path) {
  console.error("Aufruf: bun scripts/demo-seed.ts <pfad-zur-demo.db>");
  process.exit(1);
}

const store = openStore(path);
const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const items = [
  { id: "wi_0142", title: "Rotation ignoriert Cooldowns", size: "M" },
  { id: "wi_0143", title: "Cooldown-Anzeige im Menue", size: "S" },
  { id: "wi_0140", title: "Lua-Lint im Gate-Profil", size: "S" },
  { id: "wi_0139", title: "Kampfprotokoll ohne Zeitstempel", size: "S" },
  { id: "wi_0138", title: "Rotationsliste sortieren", size: "XS" },
];
for (const it of items) {
  store.createWorkItem({
    id: it.id,
    projectPath: "C:/demo/lua-rotation",
    type: "bugfix",
    title: it.title,
    description: "Demo-Auftrag",
    size: it.size as never,
  });
}

const ev = (traceId: string, type: string, actor: string, data: unknown, minutesAgo: number) =>
  store.append({ traceId, spanId: `${traceId}-${type}-${minutesAgo}`, project: "lua-rotation", type, actor: actor as never, data: data as never, ts: iso(minutesAgo) });

// wi_0142: laeuft, Implementer
ev("wi_0142", "phase.entered", "orchestrator", { name: "analyst" }, 40);
ev("wi_0142", "run.finished", "role:analyst", { ok: true, tokens: { input: 12000, output: 3000 }, model: "sonnet" }, 35);
ev("wi_0142", "phase.entered", "orchestrator", { name: "implement" }, 20);
ev("wi_0142", "acceptance.green", "role:implementer", {}, 5);

// wi_0143: wartet auf Freigabe
ev("wi_0143", "phase.entered", "orchestrator", { name: "planning" }, 25);
ev("wi_0143", "approval.requested", "orchestrator", { kind: "h1" }, 22);

// wi_0140: Review offen
ev("wi_0140", "phase.entered", "orchestrator", { name: "review" }, 60);
ev("wi_0140", "review.changes_requested", "role:reviewer", { note: "Eine Anmerkung offen" }, 15);

// wi_0139: fehlgeschlagen
ev("wi_0139", "workitem.failed", "orchestrator", { reason: "Gate lint fehlgeschlagen" }, 120);

// wi_0138: fertig
ev("wi_0138", "phase.entered", "orchestrator", { name: "integrate" }, 300);
ev("wi_0138", "workitem.done", "orchestrator", {}, 280);
store.updateWorkItem("wi_0138", { status: "done" });
store.updateWorkItem("wi_0139", { status: "failed" });
store.updateWorkItem("wi_0140", { status: "escalated" });
store.updateWorkItem("wi_0142", { status: "running" });
store.updateWorkItem("wi_0143", { status: "queued" });

// Freigaben
store.createApproval("wi_0143", "h1", { note: "Plan bereit, Freigabe fuer Umsetzung" });
store.createApproval("wi_0142", "routing_change", { role: "implementer", from: "sonnet", to: "haiku", evidence: { runs: 25, firstPassRate: 0.88 } });

// Story-Verlauf: Schritte je Rollen-Aufruf fuer eine Story.
const steps: [string, string, string, boolean, string[], number, number][] = [
  ["analyst", "opus", "spec", true, [], 6, 5],
  ["test-engineer", "sonnet", "acceptance", true, ["spec/acceptance/cooldown_spec.lua"], 4, 3],
  ["implementer", "sonnet", "implement", false, ["src/rotation.lua"], 3, 2],
  ["implementer", "sonnet", "implement", true, ["src/rotation.lua"], 2, 1],
  ["code-reviewer", "opus", "review", true, [], 1, 0],
];
for (const [role, model, _phase, ok, files, startMin, endMin] of steps) {
  store.recordStep({
    workItemId: "wi_0142",
    role,
    model,
    ok,
    ...(ok ? {} : { reason: "Abnahmetest rot: Cooldown-Filter fehlt" }),
    files,
    startedAt: iso(startMin),
    endedAt: iso(endMin),
  });
}

store.close();
console.log(`Demo-Datenbank befuellt: ${path}`);
