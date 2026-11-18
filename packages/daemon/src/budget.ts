/**
 * Kontext-Budget je Session. Gemessen wird die Groesse des Kontextfensters
 * (Eingabe + Cache-Lesen + Cache-Schreiben) aus dem usage-Feld jedes Assistant-Turns.
 * Die Ausgabe-Tokens zaehlen nicht, sie wachsen erst im naechsten Turn in den Kontext.
 */

export const SESSION_LIMIT_TOKENS = 200_000;

export interface UsageLike {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export function contextTokens(u: UsageLike): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

export class ContextBudget {
  /** Hoechster gemessener Kontext dieser Session. */
  peak = 0;
  /** Ob das Limit schon ueberschritten wurde. */
  exceeded = false;

  constructor(readonly limit: number = SESSION_LIMIT_TOKENS) {}

  /** Liefert true genau einmal: beim ersten Turn, der das Limit ueberschreitet. */
  observe(u: UsageLike): boolean {
    const c = contextTokens(u);
    if (c > this.peak) this.peak = c;
    if (!this.exceeded && c > this.limit) {
      this.exceeded = true;
      return true;
    }
    return false;
  }
}
