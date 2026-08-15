import { build } from "../build";
import { findRoot } from "../scan";
import { rankSymbols, explicitFilesFromTask } from "../query";
import { buildBm25Index } from "../bm25";
import { assemble } from "../assemble";
import { buildDirCards, dirOf } from "../dirmap";
import { estTokens } from "../tokens";
import { projectSavings, type Savings } from "../savings";
import { readHookState, writeHookState } from "./state";
import { loadCache } from "../cache";
import { changedFiles } from "../diff";
import { createHash } from "node:crypto";

const HOOK_TIMEOUT_MS = Number(process.env.CONTEXT_HOOK_TIMEOUT_MS ?? 1000);
const HOOK_BUDGET = Number(process.env.CONTEXT_HOOK_BUDGET ?? 600);

interface HookOut {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
}

export interface HookOpts {
  /** process.exit(0) after emitting (CLI adapter mode). Default true. */
  exit?: boolean;
  /** host session_id: the per-session running token-savings total is keyed by it */
  sessionId?: string;
}

// Cheap repo-affinity stopwords: a prompt that only shares these with the repo
// is pure chat. Kept tiny — the gate must over-match, never under-match, since
// a false skip just falls through to the agent's own tools.
const STOP = new Set([
  "the", "this", "that", "with", "from", "what", "where", "how", "why", "when",
  "should", "would", "could", "will", "can", "are", "was", "were", "have", "has",
  "does", "did", "for", "you", "your", "not", "but", "and", "please", "just",
  "really", "basically", "need", "make", "change", "update", "help", "write",
  "read", "fix", "add", "remove", "work", "thing", "way",
]);

function promptTerms(task: string): string[] {
  const out = new Set<string>();
  for (const tok of task.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || STOP.has(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

/**
 * Repo-affinity pre-filter for the prompt hook: a prompt that shares no term
 * with any cached file path or symbol name is pure chat / instructions — skip
 * the build and the injection entirely. Reads only the cache (no scan, no
 * parse, no git), so it is far cheaper than the build it avoids. A missing or
 * version-stale cache falls through to the full path, so a first prompt in a
 * fresh repo still injects.
 */
async function hasRepoAffinity(task: string, root: string): Promise<boolean> {
  const rec = await loadCache(root);
  if (!rec) return true;
  const terms = promptTerms(task);
  if (!terms.length) return false;
  const repo = new Set<string>();
  for (const f of Object.keys(rec.manifest)) {
    for (const seg of f.split(/[/.\-_]/)) {
      if (seg.length >= 3) repo.add(seg.toLowerCase());
    }
  }
  for (const s of rec.graph.symbols) repo.add(s.name.toLowerCase());
  return terms.some((t) => repo.has(t));
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
  let finished = false;
  const done = (): HookOut => {
    if (finished) return out; // timer already fired: never double-emit
    finished = true;
    clearTimeout(timer);
    if (exit) {
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }
    return out;
  };
  const timer = setTimeout(() => done(), HOOK_TIMEOUT_MS);
  timer.unref?.();

  try {
    if (!task || task.trim().length < 40) return done(); // trivial/short prompts skip
    const repoRoot = (await findRoot(cwd)) ?? cwd; // hook maps the whole repo
    // pure-chat prompts skip the build entirely (cache-only, no scan/parse)
    if (!(await hasRepoAffinity(task, repoRoot))) return done();
    const b = await build(repoRoot);
    const changed = await changedFiles(b.root);
    const key = createHash("sha256")
      .update(task + "\0" + b.treeHash + "\0" + [...changed].sort().join("\0"))
      .digest("hex")
      .slice(0, 16);
    const state = await readHookState(repoRoot);
    if (state.key === key) return done(); // already injected for this state
    // session-delta: hits already shown for this tree are flagged, not
    // re-served as new (one-time full orientation, then only what is new)
    const seenItems = state.seen?.tree === b.treeHash ? new Set(state.seen.items) : undefined;

    const bm25 = b.graph.symbols.length ? buildBm25Index(b.graph) : undefined;
    const explicit = explicitFilesFromTask(task, b.files);
    const hits = rankSymbols({ task, graph: b.graph, changed, explicitFiles: explicit, bm25 });
    const capsule = assemble({ task, build: b, hits, budgetTokens: HOOK_BUDGET, changed });
    if (!capsule.hits.length) {
      state.key = key;
      await writeHookState(repoRoot, state).catch(() => {});
      return done(); // low confidence: preserve normal tool fallback
    }

    // orientation: DirMap L0 first, then the file-attachment neighborhood.
    // The first injection carries the task's directory cards; when the task
    // names files (attachments), their directories' cards are shown too.
    const cards = buildDirCards(b);
    const block: string[] = [];
    block.push(`[context capsule — navigation only, not evidence]`);
    block.push(`working_tree: ${capsule.workingTree}`);
    if (capsule.dirs.length) {
      block.push(`directories:`);
      for (const d of capsule.dirs.slice(0, 2)) {
        block.push(`- ${d.path}/ (${d.files} files, ${d.lang})${d.surface.length ? ` public: ${d.surface.join(", ")}` : ""}`);
      }
      for (const f of explicit.slice(0, 2)) {
        const dc = cards.get(dirOf(f));
        if (dc && !capsule.dirs.some((d) => d.path === dc.path)) {
          block.push(`- ${dc.path}/ (${dc.files} files, ${dc.lang})${dc.surface.length ? ` public: ${dc.surface.join(", ")}` : ""}  [attached]`);
        }
      }
    }
    block.push(`paths:`);
    for (const f of capsule.files) block.push(`- ${f}`);
    block.push(`relevant symbols:`);
    for (const h of capsule.hits.slice(0, 6)) {
      const seen = seenItems?.has(`${h.file}:${h.line}`) ? " (already shown)" : "";
      block.push(`- ${h.kind} ${h.name} ${h.file}:${h.line} (${h.conf})${seen}`);
    }
    block.push(`hint: expand with \`context expand ${capsule.hits[0]?.handle}\``);
    out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: block.join("\n") };

    // project Graft-style savings from the files the capsule replaces, fold
    // into the session running total (statusline's `~N tok saved`), and
    // snapshot the graph size for the statusline (fresh: this build just
    // brought the graph up to date with the tree)
    const savings = await projectSavings(b, capsule);
    state.key = key;
    state.seen = { tree: b.treeHash, items: capsule.hits.map((h) => `${h.file}:${h.line}`) };
    state.savings = savings;
    const sid = opts.sessionId || "default";
    state.sessions = { ...(state.sessions ?? {}), [sid]: (state.sessions?.[sid] ?? 0) + savings.savedTokens };
    state.status = {
      symbols: b.graph.symbols.length,
      edges: b.graph.edges.length,
      files: b.files.length,
      treeHash: b.treeHash,
      updatedAt: Date.now(),
    };
    state.dirty = false;
    state.staleCount = changed.size;
    await writeHookState(repoRoot, state).catch(() => {});
    console.error("context:telemetry " + JSON.stringify({ cmd: "hook", capsuleTokens: capsule.tokensUsed, savedTokens: savings.savedTokens, savedPct: Math.round(savings.savedPct), outputTokens: estTokens(JSON.stringify(out)), totalMs: Math.round(performance.now() - t0) }));
    return done();
  } catch {
    return done(); // fail open
  }
}
