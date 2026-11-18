#!/usr/bin/env bun
/**
 * Nachgebautes claude-Binary fuer End-to-End-Tests der CLI.
 * Spricht das Stream-JSON-Protokoll von `claude -p --output-format stream-json`,
 * erkennt die Rolle am angehaengten Systemprompt und bearbeitet echte Dateien im cwd.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_SPEC, FIXED_ROTATION } from "../helpers";

const args = Bun.argv.slice(2);
const sys = args[args.indexOf("--append-system-prompt") + 1] ?? "";
const model = args[args.indexOf("--model") + 1] ?? "?";
const cwd = process.cwd();
const out = (o: object) => console.log(JSON.stringify(o));

out({ type: "system", subtype: "init", session_id: `fake-${model}`, model });

let structured: object;
if (sys.includes("Du bist der Test Engineer")) {
  mkdirSync(join(cwd, "spec/acceptance"), { recursive: true });
  writeFileSync(join(cwd, "spec/acceptance/cooldown_spec.lua"), ACCEPTANCE_SPEC);
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "spec/acceptance/cooldown_spec.lua" } }] } });
  structured = { summary: "Abnahmetest geschrieben", acceptance_tests: ["spec/acceptance/cooldown_spec.lua"], claims: [] };
} else if (sys.includes("Du bist der Implementer")) {
  writeFileSync(join(cwd, "src/rotation.lua"), FIXED_ROTATION);
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/rotation.lua" } }] } });
  structured = {
    summary: "Cooldown geprueft",
    changed_files: ["src/rotation.lua"],
    claims: [{ text: "Cooldown wird geprueft", level: "EXTRACTED", evidence: [{ type: "file", path: "src/rotation.lua", lines: [9, 9], quote: "local ready = (spell.cooldown or 0) <= 0" }] }],
  };
} else if (sys.includes("Du bist der Code Reviewer")) {
  structured = { verdict: "approve", summary: "ok", findings: [], claims: [] };
} else {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "unbekannte Rolle" });
  process.exit(1);
}
out({ type: "assistant", message: { content: [{ type: "text", text: "Erledigt, Tests ausgefuehrt." }] } });
out({ type: "result", subtype: "success", is_error: false, result: "fertig", structured_output: structured, session_id: `fake-${model}`, usage: { input_tokens: 100, output_tokens: 20 } });
