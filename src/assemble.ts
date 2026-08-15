import type { RankedHit } from "./query";
import { meaningfulTerms } from "./query";
import type { BuildResult } from "./build";
import { estTokens } from "./tokens";
import { serializedCost } from "./render";
import { buildDirCards, rankDirCards, mergeSemanticDirs, type DirCard } from "./dirmap";
import type { SemanticDirHit } from "./semantic";

export interface CapsuleHit {
  handle: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  range: string; // complete source span "sl-el"
  sig: string;
  reason: string[];
  conf: string;
}

export interface Capsule {
  query: string;
  root: string;
  gitHead: string | null;
  workingTree: string;
  budgetTokens: number;
  tokensUsed: number;
  truncated: boolean;
  changed: string[]; // bounded working-tree context, separate from task relevance
  dirs: DirCard[]; // DirMap L0: top task-affine directories
  files: string[]; // orientation: relevant files
  entryPoints: string[];
  hits: CapsuleHit[];
  unresolvedTerms: string[];
  next: string[];
}

const MAX_SIG = 100;
const CHANGED_MAX = 8;

export interface AssembleOpts {
  task: string;
  build: BuildResult;
  hits: RankedHit[];
  budgetTokens: number;
  changed?: Set<string> | string[];
  /** semantic directory candidates from the weak-confidence lane; when
   *  present they lead the DirMap (fusion after the confidence gate) */
  semanticDirs?: SemanticDirHit[];
}

export function assemble({ task, build, hits, budgetTokens, changed, semanticDirs }: AssembleOpts): Capsule {
  const t = meaningfulTerms(task);
  const hitTerms = hits.map((h) => new Set(meaningfulTerms(h.symbol.name + " " + h.symbol.sig)));
  const unresolvedTerms = t.filter((term) => {
    for (const ht of hitTerms) if (ht.has(term)) return false;
    return true;
  });

  const fileScore = new Map<string, number>();
  for (const h of hits) fileScore.set(h.symbol.file, (fileScore.get(h.symbol.file) ?? 0) + h.score);
  const files = [...fileScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .slice(0, 8);

  const entryPoints = hits
    .filter((h) => h.symbol.kind === "entry")
    .map((h) => `${h.symbol.file}:${h.symbol.nameLine}`)
    .slice(0, 5);

  const capsHits: CapsuleHit[] = [];
  const selected = new Set<string>();
  for (const h of hits) {
    if (selected.has(h.symbol.id)) continue;
    selected.add(h.symbol.id);
    capsHits.push({
      handle: mkHandle(capsHits.length),
      name: h.symbol.name,
      kind: h.symbol.kind,
      file: h.symbol.file,
      line: h.symbol.nameLine,
      range: `${h.symbol.span.sl}-${h.symbol.span.el}`,
      sig: h.symbol.sig.slice(0, MAX_SIG),
      reason: h.reason,
      conf: h.conf,
    });
  }

  const changedList = [...(changed ?? [])].sort().slice(0, CHANGED_MAX);

  // DirMap L0: compact directory cards ranked by task affinity, never symbol
  // count; semantic candidates lead only when the confidence gate was weak
  const cards = buildDirCards(build);
  const dirs = semanticDirs?.length ? mergeSemanticDirs(cards, rankDirCards(cards, hits), semanticDirs) : rankDirCards(cards, hits);

  // the truthfulness contract: selection is measured on the final serialized
  // form (both renderings), not an approximation of the selected labels.
  // Drop the least useful sections deterministically until both fit.
  const capsule: Capsule = {
    query: task,
    root: build.root,
    gitHead: build.gitHead,
    workingTree: build.treeHash,
    budgetTokens,
    tokensUsed: 0,
    truncated: false,
    changed: changedList,
    dirs,
    files,
    entryPoints,
    hits: capsHits,
    unresolvedTerms,
    next: [
      ...capsHits.slice(0, 3).map((h) => `context expand ${h.handle}`),
      ...capsHits.slice(0, 3).map((h) => `context impact ${h.name}`),
    ],
  };
  return truncateToBudget(capsule, budgetTokens);
}

// Drop order: entry points and unresolved terms first, then the
// relevant-files lane, the DirMap, the changed context (re-derivable via
// git), then the next actions (cheap navigation, kept over weaker sections),
// hits last (the payload). Boilerplate (query/root/identity) is never
// dropped; if it alone exceeds the budget the capsule reports the true
// serialized cost and truncated=true. tokensUsed is part of the serialized
// form, so the measured cost must include its own final value (measured until
// fixpoint).
function truncateToBudget(c: Capsule, budget: number): Capsule {
  let truncated = false;
  for (;;) {
    c.tokensUsed = serializedCost(c);
    if (c.tokensUsed <= budget) break;
    truncated = true;
    const before = c.tokensUsed;
    if (c.entryPoints.length) c.entryPoints.pop();
    else if (c.unresolvedTerms.length) c.unresolvedTerms.pop();
    else if (c.files.length) c.files.pop();
    else if (c.dirs.length) c.dirs.pop();
    else if (c.changed.length) c.changed.pop();
    else if (c.next.length) c.next.pop();
    else if (c.hits.length) c.hits.pop();
    c.tokensUsed = serializedCost(c);
    if (c.tokensUsed >= before) break; // nothing left to drop: boilerplate alone exceeds the budget
  }
  c.truncated = truncated;
  return c;
}

export function mkHandle(i: number): string {
  return `src-${String(i + 1).padStart(2, "0")}`;
}
