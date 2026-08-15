/** Coarse token estimate. Not a provider tokenizer; always labeled `estimated`. */
export function estTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
