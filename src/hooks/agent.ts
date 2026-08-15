import { hookStatePath, readJson } from "../cache";
import { findRoot } from "../scan";
import { formatSavings, type Savings } from "../savings";
import { estTokens } from "../tokens";

export interface AgentResponseInput {
  /** the agent's response text (message, tool output tail, or transcript) */
  text: string;
  /** optional host-provided provider usage; raw, already multiplied if provider reports it */
  usage?: { input: number; output: number; total: number };
  /** codex always sends hook_event_name; claude-code does not — schema switch */
  hook_event_name?: string;
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
 *
 * Host schemas differ: Claude Code Stop expects the AgentResponseOut shape;
 * Codex Stop expects the common output fields (systemMessage is surfaced as a
 * warning in the Codex UI — the user-visible channel for the savings line).
 * Detection: Codex always sends hook_event_name; Claude Code does not.
 */
export async function runAgentHook(input: AgentResponseInput, opts: { exit?: boolean } = {}): Promise<AgentResponseOut> {
  const exit = opts.exit ?? true;
  const isCodex = (input as { hook_event_name?: string }).hook_event_name === "Stop";
  const out: AgentResponseOut = { outputTokens: estTokens(input.text), savings: null };
  try {
    // resolve repo like the user hook does, so per-repo state is scoped correctly
    const root = (await findRoot(process.cwd())) ?? process.cwd();
    const state = await readJson<{ key: string; savings?: Savings }>(hookStatePath(root));
    const s = state?.savings;
    // only report when there is something to report: a meaningful net saving
    // (projections of 0% are noise on every turn)
    if (s && s.coldTokens > 0 && s.savedTokens > 0) {
      out.savings = s;
      out.projection = formatSavings(s);
      if (input.usage) {
        out.projection += ` | provider input=${input.usage.input} output=${input.usage.output} total=${input.usage.total}`;
      }
    }
  } catch {}
  if (exit) {
    if (isCodex) {
      // Codex common output fields: systemMessage surfaces as a UI warning.
      // Empty output = success + silence: no savings, no warning.
      process.stdout.write(JSON.stringify(out.projection ? { systemMessage: out.projection } : {}));
    } else {
      process.stdout.write(JSON.stringify(out));
    }
    process.exit(0);
  }
  return out;
}
