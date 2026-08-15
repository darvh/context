import type { RankedHit } from "../rank/query";
import { meaningfulTerms, queryConfidence, type QueryConfidence } from "../rank/query";
import type { BuildResult } from "./build";
import { estTokens } from "../core/tokens";
import { serializedCost } from "./render";
import { buildDirCards, rankDirCards, mergeSemanticDirs, type DirCard } from "../graph/dirmap";
import type { SemanticDirHit } from "../rank/semantic";

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
  score: number;
}

export interface Capsule {
  query: string;
  root: string;
  gitHead: string | null;
  workingTree: string;
  budgetTokens: number;
  tokensUsed: number;
  truncated: boolean;
  confidence: QueryConfidence;
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

const CONF_FACTOR: Record<string, number> = { exact: 1, resolved: 0.75, heuristic: 0.5 };
const PACK_PINNED = new Set(["exact-name", "explicit-file", "recent-change"]);
const NOVELTY_DUP = 0.5; // same-file repeat penalty

export interface AssembleOpts {
  task: string;
  build: BuildResult;
  hits: RankedHit[];
  budgetTokens: number;
  changed?: Set<string> | string[];
  /** semantic directory candidates from the weak-confidence lane; when
   *  present they lead the DirMap (fusion after the confidence gate) */
  semanticDirs?: SemanticDirHit[];
  /** symbols ("file:line") already shown to the agent this session: session-
   *  delta novelty, disposable per tree */
  seen?: Set<string>;
}

export function assemble({ task, build, hits, budgetTokens, changed, semanticDirs, seen }: AssembleOpts): Capsule {
  const t = meaningfulTerms(task);
  const hitTerms = hits.map((h) => new Set(meaningfulTerms(h.symbol.name + " " + h.symbol.sig)));
  const unresolvedTerms = t.filter((term) => {
    for (const ht of hitTerms) if (ht.has(term)) return false;
    return true;
  });

  // DirMap L0: compact directory cards ranked by task affinity, never symbol
  // count; semantic candidates lead only when the confidence gate was weak
  const cards = buildDirCards(build);
  const rankedDirs = semanticDirs?.length ? mergeSemanticDirs(cards, rankDirCards(cards, hits), semanticDirs) : rankDirCards(cards, hits);
  const dirAffinity = new Map(rankDirCards(cards, hits).map((d, i) => [d.path, hits.length - i]));

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
      score: Math.round(h.score * 100) / 100,
    });
  }

  const changedList = [...(changed ?? [])].sort().slice(0, CHANGED_MAX);

  // Budget-aware context packing: every candidate (hit, dir card, next action,
  // changed file, unresolved term) is scored by utility per serialized token —
  // relevance × confidence × novelty — and selected greedily. Authoritative
  // pins lead; minimal orientation (one directory, one hit) is guaranteed when
  // it fits. Replaces fixed "append whole sections, then drop" composition.
  const capsule: Capsule = {
    query: task,
    root: build.root,
    gitHead: build.gitHead,
    workingTree: build.treeHash,
    budgetTokens,
    tokensUsed: 0,
    truncated: false,
    confidence: queryConfidence(hits),
    changed: [],
    dirs: [],
    files: [],
    entryPoints: [],
    hits: [],
    unresolvedTerms: [],
    next: [],
  };
  return packToBudget(capsule, budgetTokens, { capsHits, rankedDirs, dirAffinity, unresolvedTerms, changedList, seen });
}

interface Packable {
  kind: "hit" | "dir" | "next" | "changed" | "unresolved" | "entry";
  utility: number;
  cost: number;
  add: () => void;
}

function packToBudget(
  c: Capsule,
  budget: number,
  src: { capsHits: CapsuleHit[]; rankedDirs: DirCard[]; dirAffinity: Map<string, number>; unresolvedTerms: string[]; changedList: string[]; seen?: Set<string> },
): Capsule {
  const hitCost = (h: CapsuleHit) => estTokens(`${h.handle} ${h.kind} ${h.name} ${h.file}:${h.line} ${h.sig} ${h.reason.join(",")}`);
  const dirCost = (d: DirCard) => estTokens(`${d.path} ${d.files} ${d.lang} ${d.surface.join(" ")}`);
  const pinned = (h: CapsuleHit) => h.reason.some((r) => PACK_PINNED.has(r));

  const chosen: Packable[] = [];
  const filesIn = new Set<string>();
  const addHit = (h: CapsuleHit) => {
    if (c.hits.includes(h)) return;
    c.hits.push(h);
    filesIn.add(h.file);
  };
  const addDir = (d: DirCard) => {
    if (c.dirs.includes(d)) return;
    c.dirs.push(d);
  };

  // pins first, then minimal orientation: top dir + top hit when they fit
  const pick: Packable[] = [];
  for (const h of src.capsHits) {
    if (!pinned(h)) continue;
    pick.push({ kind: "hit", utility: 10, cost: hitCost(h), add: () => addHit(h) });
  }
  for (const h of src.capsHits) {
    if (pinned(h)) continue;
    pick.push({
      kind: "hit",
      utility: h.score * (CONF_FACTOR[h.conf] ?? 0.5) * (filesIn.has(h.file) ? NOVELTY_DUP : 1) * (src.seen?.has(`${h.file}:${h.line}`) ? 0.15 : 1),
      cost: hitCost(h),
      add: () => addHit(h),
    });
  }
  for (const d of src.rankedDirs) {
    pick.push({ kind: "dir", utility: src.dirAffinity.get(d.path) ?? 1, cost: dirCost(d), add: () => addDir(d) });
  }

  // minimal orientation: top dir + top hit always lead when they fit
  const firstDir = src.rankedDirs[0];
  const firstHit = src.capsHits[0];
  if (firstDir) addDir(firstDir);
  if (firstHit) addHit(firstHit);

  // greedy selection by utility per token
  const byRatio = [...pick].sort((a, b) => b.utility / b.cost - a.utility / a.cost || b.utility - a.utility);
  for (const p of byRatio) {
    c.tokensUsed = serializedCost(c);
    if (c.tokensUsed + p.cost <= budget) p.add();
  }

  // derived lanes from the selected hits (files/entryPoints/next are
  // navigation affordances, not independent candidates)
  const fileScore = new Map<string, number>();
  for (const h of c.hits) fileScore.set(h.file, (fileScore.get(h.file) ?? 0) + h.score);
  c.files = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 8);
  c.entryPoints = src.capsHits.filter((h) => h.kind === "entry" && c.hits.includes(h)).map((h) => `${h.file}:${h.line}`).slice(0, 5);
  c.next = [
    ...c.hits.slice(0, 3).map((h) => `context expand ${h.handle}`),
    ...c.hits.slice(0, 3).map((h) => `context impact ${h.name}`),
  ];
  c.changed = src.changedList;
  c.unresolvedTerms = src.unresolvedTerms;
  c.dirs = c.dirs.slice(0, 3);

  // final fit: serialized cost measured to fixpoint (tokensUsed is part of
  // the serialized form); remove the lowest-utility lanes first, pins last.
  // truncated reflects what the consumer sees: anything popped = cut output
  let truncated = false;
  for (;;) {
    c.tokensUsed = serializedCost(c);
    if (c.tokensUsed <= budget) break;
    truncated = true;
    const before = c.tokensUsed;
    if (c.next.length) c.next.pop();
    else if (c.entryPoints.length) c.entryPoints.pop();
    else if (c.unresolvedTerms.length) c.unresolvedTerms.pop();
    else if (c.changed.length) c.changed.pop();
    else if (c.dirs.length) c.dirs.pop();
    else if (c.hits.some((h) => !pinned(h))) {
      // remove the lowest-utility unpinned hit; pinned hits stay to the end
      let worst = -1;
      let wi = -1;
      c.hits.forEach((h, i) => {
        if (pinned(h)) return;
        const u = h.score * (CONF_FACTOR[h.conf] ?? 0.5);
        if (wi < 0 || u < worst) {
          worst = u;
          wi = i;
        }
      });
      c.hits.splice(wi, 1);
    } else if (c.hits.length) c.hits.pop();
    c.tokensUsed = serializedCost(c);
    if (c.tokensUsed >= before) break; // nothing left to drop: boilerplate alone exceeds the budget
  }
  c.truncated = truncated;
  return c;
}

export function mkHandle(i: number): string {
  return `src-${String(i + 1).padStart(2, "0")}`;
}
