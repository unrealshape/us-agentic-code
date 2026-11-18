import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkItem } from "./store";

/** Liest den Rollen-Prompt aus agents/<rolle>.md (ohne Frontmatter). */
export function rolePrompt(pluginRoot: string, role: string): string {
  const p = join(pluginRoot, "agents", `${role}.md`);
  if (!existsSync(p)) throw new Error(`Rollen-Datei fehlt: ${p}`);
  const raw = readFileSync(p, "utf8");
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

/** Liest das JSON-Schema der Rollen-Ausgabe (fuer --json-schema). */
export function roleSchema(pluginRoot: string, role: string): object | undefined {
  const p = join(pluginRoot, "schemas", `${role}.schema.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

export const PRECISION_RULES = `Regeln fuer jede Aussage:
- Jede Aussage traegt eine Stufe: VERIFIED (durch Test/Befehl bestaetigt), EXTRACTED (direkt gelesen), INFERRED (abgeleitet, ungeprueft) oder UNKNOWN.
- VERIFIED und EXTRACTED brauchen Belege. Datei-Belege nennen Pfad, Zeilenbereich und ein woertliches Zitat aus genau diesen Zeilen; sie werden mechanisch geprueft.
- Wenn du etwas nicht belegen kannst, schreibe UNKNOWN und stelle eine Frage. Rate nie.
- Antworte am Ende ausschliesslich mit dem geforderten JSON.`;

export const GRAPH_NOTE = `Projektgraph: Im Projektordner liegt graphify-out/ (Graphify, tree-sitter). Nutze ihn vor dem Suchen im Code:
- graphify query "<Begriff>"  ·  graphify path "A" "B"  ·  graphify explain "X"
- Nur Kanten mit [EXTRACTED] gelten als Fakt; [INFERRED]/[AMBIGUOUS] musst du im Code pruefen.`;

export function taskBlock(wi: WorkItem): string {
  return `Auftrag (${wi.type}, Groesse ${wi.size}): ${wi.title}\n\n${wi.description}`;
}

export function testEngineerPrompt(wi: WorkItem, feedback?: string): string {
  return [
    taskBlock(wi),
    `Deine Aufgabe: Schreibe ZUERST einen ausfuehrbaren Abnahmetest, der das erwartete Verhalten aus Nutzersicht prueft.
- Der Test muss mit dem aktuellen Code ROT sein (er beweist den Fehler bzw. das fehlende Verhalten).
- Aendere ausschliesslich Testdateien. Produktivcode ist tabu.
- Lege den Abnahmetest unter spec/acceptance/ ab (oder im Testordner des Projekts).
- Nenne in "acceptance_tests" die Pfade relativ zum Projektordner.`,
    feedback ? `Rueckmeldung zum letzten Versuch:\n${feedback}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function implementerPrompt(wi: WorkItem, acceptanceFiles: string[], lastFailure?: string): string {
  return [
    taskBlock(wi),
    `Deine Aufgabe: Aendere den Produktivcode so, dass der gesperrte Abnahmetest und alle Gates gruen werden.
- Gesperrte Abnahmetests (nicht aendern, nicht loeschen, nicht ueberspringen): ${acceptanceFiles.join(", ")}
- Testdateien, Gate-Konfiguration und Skip-Marker sind tabu; Verstoesse werden automatisch verworfen.
- Fuehre die Tests selbst aus und berichte nur, was die Ausgabe belegt.`,
    lastFailure ? `Ergebnis des letzten Versuchs (Gate-Ausgabe):\n${lastFailure}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reviewerPrompt(wi: WorkItem, diff: string, feedback?: string): string {
  return [
    taskBlock(wi),
    `Deine Aufgabe: Pruefe die Aenderung unten. Du kennst die Implementierung nicht und bewertest nur, was im Code steht.
- Befunde "critical" und "high" brauchen Belege.
- verdict "approve" nur, wenn keine critical/high-Befunde bleiben.`,
    "Diff:\n```diff\n" + diff.slice(0, 40_000) + "\n```",
    feedback ? `Rueckmeldung zu deiner letzten Ausgabe:\n${feedback}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}
