import type { Store } from "./store";

/** Platzhalter-Schaetzung des Token-Kontingents; vom Nutzer zu ersetzen (Konfiguration, nicht CLI). */
export const DEFAULT_MAX_TOKENS = 1_000_000;

/** Anteil des genutzten Kontingents seit `since`, geschaetzt aus run.finished-Token-Events. */
export function budgetUsedFraction(
  store: Store,
  since: Date,
  maxTokens: number,
): { fraction: number; estimated: true } {
  const sinceMs = since.getTime();
  let used = 0;
  for (const ev of store.events({ type: "run.finished" })) {
    if (new Date(ev.ts).getTime() < sinceMs) continue;
    const t = (ev.data as { tokens?: { input?: number; output?: number } } | null)?.tokens;
    used += (t?.input ?? 0) + (t?.output ?? 0);
  }
  return { fraction: maxTokens > 0 ? used / maxTokens : 0, estimated: true };
}
