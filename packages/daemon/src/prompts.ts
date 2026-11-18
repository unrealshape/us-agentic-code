import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCriterion, AnalystOutput, Slice } from "@usac/shared";
import type { Constitution, Rule } from "./rules";
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

/**
 * Verfassung fuer eine Rolle: Kernregeln plus die Teile, deren Rollen passen.
 * Jede Regel traegt ihre ID, damit Aussagen und Befunde sie zitieren koennen.
 */
export function rulesBlock(c: Constitution, role: string): string {
  const line = (r: Rule) => `- [${r.id}] ${r.text}`;
  const parts = c.parts.filter((p) => p.rules.length > 0 && (p.roles === "all" || p.roles.includes(role)));
  if (c.core.length === 0 && parts.length === 0) return "";
  const out = [`Verfassung des Projekts (aus CLAUDE.md; nenne bei Bezug die Regel-ID):`];
  if (c.core.length > 0) out.push(`Kern:\n${c.core.map(line).join("\n")}`);
  for (const p of parts) out.push(`${p.name || "Allgemein"}:\n${p.rules.map(line).join("\n")}`);
  return out.join("\n\n");
}

export function taskBlock(wi: WorkItem): string {
  return `Auftrag (${wi.type}, Groesse ${wi.size}): ${wi.title}\n\n${wi.description}`;
}

export function analystPrompt(wi: WorkItem, feedback?: string): string {
  return [
    taskBlock(wi),
    `Deine Aufgabe: Mache aus dem Auftrag eine Spec mit pruefbaren Akzeptanzkriterien.
- Du schreibst keine Dateien. Liefere die Spec ausschliesslich als JSON; spec/feature.md erzeugt der Orchestrator daraus.
- Jedes Kriterium hat eine ID (AC-1, AC-2, ...) und given, when, then; "source" ist task, code oder user.
- Jedes Kriterium ist beobachtbar und als automatischer Test pruefbar (Eingabe, erwartetes Ergebnis, Randfall).
- Grenze in "out_of_scope" ab, was nicht Teil des Auftrags ist.
- Unklares wird zur Frage in "questions", nicht zur Annahme.`,
    feedback ? `Rueckmeldung zum letzten Versuch:\n${feedback}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function criteriaBlock(criteria: AcceptanceCriterion[]): string {
  return criteria.map((c) => `- ${c.id}: Gegeben ${c.given}, wenn ${c.when}, dann ${c.then}`).join("\n");
}

export function techLeadPrompt(wi: WorkItem, spec: AnalystOutput, feedback?: string): string {
  return [
    taskBlock(wi),
    `Spec: ${spec.title}\n${spec.summary}\n\nAkzeptanzkriterien:\n${criteriaBlock(spec.criteria)}`,
    `Deine Aufgabe: Plane rueckwaerts und zerlege die Spec in Slices.
- Du schreibst keine Dateien. Liefere den Plan ausschliesslich als JSON.
- Plane höchstens 8 Slices; jeder Slice hat eine ID (S1, S2, ...), einen Titel, Kriterien-IDs, Dateien und depends_on.
- Jedes Kriterium der Spec gehoert zu mindestens einem Slice.
- "files" nennt die Dateien, die der Slice aendern darf (Leases); Abhaengigkeiten duerfen keine Zyklen bilden.
- Stufe die Groesse ein: trivial, small, standard oder large.`,
    feedback ? `Rueckmeldung zum letzten Versuch:\n${feedback}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function testEngineerPrompt(
  wi: WorkItem,
  feedback?: string,
  slice?: { slice: Slice; criteria: AcceptanceCriterion[] },
): string {
  return [
    taskBlock(wi),
    slice
      ? `Deine Aufgabe: Schreibe ZUERST ausfuehrbare Tests fuer Slice ${slice.slice.id} (${slice.slice.title}).
- Nur Tests für diesen Slice; die Tests muessen mit dem aktuellen Code ROT sein.
- Aendere ausschliesslich Testdateien. Produktivcode ist tabu.
- Kriterien dieses Slice:
${criteriaBlock(slice.criteria)}
- Nenne in "acceptance_tests" die Pfade relativ zum Projektordner.`
      : `Deine Aufgabe: Schreibe ZUERST einen ausfuehrbaren Abnahmetest, der das erwartete Verhalten aus Nutzersicht prueft.
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

export function securityReviewerPrompt(wi: WorkItem, diff: string, triggers: string[], feedback?: string): string {
  return [
    taskBlock(wi),
    `Deine Aufgabe: Pruefe die Aenderung unten ausschliesslich auf Sicherheit. Du kennst die Implementierung und andere Reviews nicht und bewertest nur, was im Code steht.
- Ausgeloeste Security-Trigger: ${triggers.join(", ")}. Pruefe diese Bereiche gezielt (z. B. Rechtepruefung, Geheimnisse im Code, Injection, Befehlsausfuehrung, Datei- und Netzzugriffe, neue Abhaengigkeiten, CI-Rechte).
- Befunde "critical" und "high" brauchen Belege.
- verdict "approve" nur, wenn keine critical/high-Befunde bleiben.`,
    "Diff:\n```diff\n" + diff.slice(0, 40_000) + "\n```",
    feedback ? `Rueckmeldung zu deiner letzten Ausgabe:\n${feedback}` : "",
    PRECISION_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}
