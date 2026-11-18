/**
 * Erzeugt die JSON-Schemas der Rollen-Ausgaben (fuer claude --json-schema).
 * Muss zu den zod-Schemas in packages/shared/src/index.ts passen; ein Test prueft das.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const evidence = {
  oneOf: [
    {
      type: "object",
      required: ["type", "path", "lines", "quote"],
      properties: {
        type: { const: "file" },
        path: { type: "string", description: "Pfad relativ zum Projektordner" },
        lines: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2, description: "[start, ende], 1-basiert" },
        quote: { type: "string", description: "woertliches Zitat aus diesen Zeilen" },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "gate_result_id"],
      properties: { type: { const: "gate" }, gate_result_id: { type: "integer" } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "url"],
      properties: { type: { const: "url" }, url: { type: "string" } },
      additionalProperties: false,
    },
  ],
};

const claim = {
  type: "object",
  required: ["text", "level", "evidence"],
  properties: {
    text: { type: "string" },
    level: { enum: ["VERIFIED", "EXTRACTED", "INFERRED", "UNKNOWN"] },
    evidence: { type: "array", items: evidence },
  },
  additionalProperties: false,
};

const claims = { type: "array", items: claim };
const questions = { type: "array", items: { type: "string" } };

const schemas: Record<string, object> = {
  "test-engineer": {
    type: "object",
    required: ["summary", "acceptance_tests", "claims"],
    properties: { summary: { type: "string" }, acceptance_tests: { type: "array", items: { type: "string" }, minItems: 1 }, claims, questions },
    additionalProperties: false,
  },
  implementer: {
    type: "object",
    required: ["summary", "changed_files", "claims"],
    properties: { summary: { type: "string" }, changed_files: { type: "array", items: { type: "string" } }, claims, questions },
    additionalProperties: false,
  },
};

const review = {
  type: "object",
  required: ["verdict", "summary", "findings", "claims"],
  properties: {
    verdict: { enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "text", "evidence"],
        properties: { severity: { enum: ["critical", "high", "medium", "low"] }, text: { type: "string" }, evidence: { type: "array", items: evidence } },
        additionalProperties: false,
      },
    },
    claims,
  },
  additionalProperties: false,
};
schemas["code-reviewer"] = review;
schemas["security-reviewer"] = review;

const root = join(import.meta.dir, "..");
for (const [role, schema] of Object.entries(schemas)) {
  writeFileSync(join(root, "schemas", `${role}.schema.json`), JSON.stringify(schema, null, 2) + "\n");
}
console.log(`${Object.keys(schemas).length} Schemas geschrieben`);
