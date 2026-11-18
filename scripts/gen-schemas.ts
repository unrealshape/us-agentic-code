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
    {
      type: "object",
      required: ["type", "node_id", "path", "lines", "quote"],
      properties: {
        type: { const: "graph" },
        node_id: { type: "string", description: "Knoten-ID aus graphify-out/graph.json" },
        path: { type: "string", description: "Quelldatei des Knotens, relativ zum Projektordner" },
        lines: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 2, description: "[start, ende], 1-basiert" },
        quote: { type: "string", description: "woertliches Zitat aus diesen Zeilen" },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "id"],
      properties: { type: { const: "memory" }, id: { type: "string", description: "ID eines Memory-Eintrags" } },
      additionalProperties: false,
    },
  ],
};

const fileEvidence = evidence.oneOf[0];

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
  analyst: {
    type: "object",
    required: ["summary", "title", "criteria", "claims"],
    properties: {
      summary: { type: "string" },
      title: { type: "string" },
      criteria: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id", "given", "when", "then", "source"],
          properties: {
            id: { type: "string", pattern: "^AC-\\d+$" },
            given: { type: "string" },
            when: { type: "string" },
            then: { type: "string" },
            source: { enum: ["task", "code", "user"] },
          },
          additionalProperties: false,
        },
      },
      out_of_scope: { type: "array", items: { type: "string" } },
      claims,
      questions,
    },
    additionalProperties: false,
  },
  "tech-lead": {
    type: "object",
    required: ["summary", "size", "slices", "claims"],
    properties: {
      summary: { type: "string" },
      size: { enum: ["trivial", "small", "standard", "large"] },
      slices: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["id", "title", "criteria", "files"],
          properties: {
            id: { type: "string", pattern: "^S\\d+$" },
            title: { type: "string" },
            criteria: { type: "array", items: { type: "string" }, minItems: 1 },
            files: { type: "array", items: { type: "string" }, minItems: 1 },
            depends_on: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      claims,
      questions,
    },
    additionalProperties: false,
  },
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
  explorer: {
    type: "object",
    required: ["summary", "languages", "commands", "conventions", "claims", "questions"],
    properties: {
      summary: { type: "string" },
      languages: { type: "array", items: { type: "string" } },
      commands: {
        type: "object",
        properties: {
          build: { type: "string" },
          test: { type: "string" },
          lint: { type: "string" },
          format: { type: "string" },
        },
        additionalProperties: false,
      },
      conventions: { type: "array", maxItems: 10, items: claim },
      claims,
      questions,
    },
    additionalProperties: false,
  },
  learner: {
    type: "object",
    required: ["summary", "instincts", "memory", "claims"],
    properties: {
      summary: { type: "string" },
      instincts: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          required: ["text", "role", "event_ids"],
          properties: {
            text: { type: "string" },
            role: { type: "string" },
            glob: { type: "string" },
            event_ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
          },
          additionalProperties: false,
        },
      },
      memory: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["kind", "text", "evidence"],
          properties: {
            kind: { type: "string" },
            text: { type: "string" },
            evidence: { type: "array", items: fileEvidence, minItems: 1 },
          },
          additionalProperties: false,
        },
      },
      claims,
    },
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
