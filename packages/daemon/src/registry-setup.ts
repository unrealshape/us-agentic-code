import { createFeatureHandlers } from "./feature-phases";
import { createIntegratorHandlers, realGh, realGit } from "./integrator";
import { registerPhase } from "./phases";
import { approveReport, createTeamHandlers } from "./team-phases";

const f = createFeatureHandlers();
registerPhase("spec", f.spec);
registerPhase("approve_spec", f.approve_spec);
registerPhase("plan", f.plan);

// Erweitertes Team (Phase 4) und Freigabe des Spike-Berichts. Die Team-Handler sind zusaetzlich
// eingebaute Phasen in orchestrator.ts, damit auch ein Orchestrator ohne diese Datei `verify` kennt.
for (const [name, handler] of Object.entries(createTeamHandlers())) registerPhase(name, handler);
registerPhase("approve_report", approveReport);

const h = createIntegratorHandlers({ git: realGit, gh: realGh });
registerPhase("push", h.push);
registerPhase("pr", h.pr);
registerPhase("approve_h2", h.approve_h2);
registerPhase("merge", h.merge);
