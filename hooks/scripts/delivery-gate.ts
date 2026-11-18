#!/usr/bin/env bun
/**
 * Delivery-Gate (Stop-Hook, Idee aus ECC skills/delivery-gate):
 * Verweigert das Ende einer Session, wenn der Abschluss Vermutungen statt Belege enthaelt.
 * Exit 2 = blockieren; stderr geht als Rueckmeldung an Claude.
 */
import { existsSync, readFileSync } from "node:fs";
import { findHedges } from "../../packages/daemon/src/evidence";

const input = JSON.parse(await Bun.stdin.text() || "{}");

// Schon einmal blockiert: nicht in eine Schleife laufen.
if (input.stop_hook_active) process.exit(0);

const path: string | undefined = input.transcript_path;
if (!path || !existsSync(path)) process.exit(0);

let lastText = "";
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const msg = JSON.parse(line);
    if (msg.type !== "assistant") continue;
    const parts = msg.message?.content ?? [];
    const text = parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join("\n");
    if (text.trim()) lastText = text;
  } catch {
    // unlesbare Zeile ignorieren
  }
}

const hedges = findHedges(lastText);
if (hedges.length) {
  console.error(
    `Delivery-Gate: Der Abschluss enthaelt Vermutungen (${hedges.map((h) => `"${h}"`).join(", ")}). ` +
      "Fuehre den passenden Pruefbefehl (Tests, Linter) aus und berichte nur, was die Ausgabe belegt.",
  );
  process.exit(2);
}
process.exit(0);
