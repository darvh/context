import { build } from "./build";
import { findRoot } from "./scan";
import { rankSymbols } from "./query";
import { assemble } from "./assemble";
import { estTokens } from "./tokens";
import { projectSavings, type Savings } from "./savings";
import { hookStatePath, readJson, writeJson } from "./cache";
import { changedFiles } from "./diff";
import { createHash } from "node:crypto";

const HOOK_TIMEOUT_MS = Number(process.env.CONTEXT_HOOK_TIMEOUT_MS ?? 1000);
const HOOK_BUDGET = Number(process.env.CONTEXT_HOOK_BUDGET ?? 600);

interface HookOut {
  hookSpecificOutput?: { additionalContext?: string };
}

export interface HookOpts {
  /** process.exit(0) after emitting (CLI adapter mode). Default true. */
  exit?: boolean;
}

/**
 * Thin UserPromptSubmit adapter. Read task, inject one compact map once per
 * (task, working-tree) pair. Short timeout, fail open, never mutate the repo.
 * Emits Claude Code hook JSON.
 */
export async function runHook(task: string, cwd: string, opts: HookOpts = {}): Promise<HookOut> {
  const t0 = performance.now();
  const exit = opts.exit ?? true;
  const out: HookOut = {};
  const done = (): HookOut => {
    if (exit) {
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }
    return out;
  };
  const timer = setTimeout(() => {
    if (exit) done();
  }, HOOK_TIMEOUT_MS);

  try {
    if (!task || task.trim().length < 40) return done(); // trivial/short prompts skip
    const repoRoot = (await findRoot(cwd)) ?? cwd; // hook maps the whole repo
    const b = await build(repoRoot);
    const changed = await changedFiles(b.root);
    const key = createHash("sha256")
      .update(task + "\0" + b.treeHash + "\0" + [...changed].sort().join("\0"))
      .digest("hex")
      .slice(0, 16);
    const state = await readJson<{ key: string }>(hookStatePath());
    if (state && state.key === key) return done(); // already injected for this state

    const hits = rankSymbols({ task, graph: b.graph, changed, explicitFiles: [] });
    const capsule = assemble({ task, build: b, hits, budgetTokens: HOOK_BUDGET });
    if (!capsule.hits.length) {
      await writeJson(hookStatePath(), { key });
      return done(); // low confidence: preserve normal tool fallback
    }

    const block: string[] = [];
    block.push(`[context capsule — navigation only, not evidence]`);
    block.push(`working_tree: ${capsule.workingTree}`);
    block.push(`paths:`);
    for (const f of capsule.files) block.push(`- ${f}`);
    block.push(`relevant symbols:`);
    for (const h of capsule.hits.slice(0, 6)) {
      block.push(`- ${h.kind} ${h.name} ${h.file}:${h.line} (${h.conf})`);
    }
    block.push(`hint: expand with \`context expand ${capsule.hits[0]?.handle}\``);
    out.hookSpecificOutput = { additionalContext: block.join("\n") };

    // project Graft-style savings from the spans the capsule replaces
    const savings = await projectSavings(b, capsule);
    await writeJson(hookStatePath(), { key, savings });
    console.error("context:telemetry " + JSON.stringify({ cmd: "hook", capsuleTokens: capsule.tokensUsed, savedTokens: savings.savedTokens, savedPct: Math.round(savings.savedPct), outputTokens: estTokens(JSON.stringify(out)), totalMs: Math.round(performance.now() - t0) }));
    clearTimeout(timer);
    return done();
  } catch {
    clearTimeout(timer);
    return done(); // fail open
  }
}
