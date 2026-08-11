import { hookStatePath, readJson } from "./cache";
import { formatSavings, type Savings } from "./savings";
import { estTokens } from "./tokens";

export interface AgentResponseInput {
  /** the agent's response text (message, tool output tail, or transcript) */
  text: string;
  /** optional host-provided provider usage; raw, already multiplied if provider reports it */
  usage?: { input: number; output: number; total: number };
}

export interface AgentResponseOut {
  /** Graft-style projection line; empty when nothing to report */
  projection?: string;
  outputTokens: number;
  savings: Savings | null;
}

/**
 * Agent-response hook: reads the savings the user hook projected for this turn
 * and emits a Graft-style "tokens saved" line. Fail-open — never blocks the
 * agent. All numbers labeled `estimated`; provider usage, when present, is
 * passed through as raw counts.
 */
export async function runAgentHook(input: AgentResponseInput, opts: { exit?: boolean } = {}): Promise<AgentResponseOut> {
  const exit = opts.exit ?? true;
  const out: AgentResponseOut = { outputTokens: estTokens(input.text), savings: null };
  try {
    const state = await readJson<{ key: string; savings?: Savings }>(hookStatePath());
    const s = state?.savings;
    if (s && s.coldTokens > 0) {
      out.savings = s;
      out.projection = formatSavings(s);
      if (input.usage) {
        out.projection += ` | provider input=${input.usage.input} output=${input.usage.output} total=${input.usage.total}`;
      }
    }
  } catch {}
  if (exit) {
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  return out;
}
