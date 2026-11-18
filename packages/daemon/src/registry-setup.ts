import { createIntegratorHandlers, realGh, realGit } from "./integrator";
import { registerPhase } from "./phases";

const h = createIntegratorHandlers({ git: realGit, gh: realGh });
registerPhase("push", h.push);
registerPhase("pr", h.pr);
registerPhase("approve_h2", h.approve_h2);
registerPhase("merge", h.merge);
