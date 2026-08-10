import type { RankedHit } from "./query";
import type { BuildResult } from "./build";
import { estTokens } from "./tokens";

export interface CapsuleHit {
  handle: string;
  name: string;
  kind: string;
  file: string;
  line: number;
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
  files: string[]; // orientation: relevant files
  entryPoints: string[];
  hits: CapsuleHit[];
  unresolvedTerms: string[];
  next: string[];
}

const MAX_SIG = 100;

export interface AssembleOpts {
  task: string;
  build: BuildResult;
  hits: RankedHit[];
  budgetTokens: number;
}

export function assemble({ task, build, hits, budgetTokens }: AssembleOpts): Capsule {
  const t = terms2(task);
  const unresolvedTerms = t.filter((term) => !hits.some((h) => terms2(h.symbol.name + " " + h.symbol.sig).includes(term)));

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
  let tokensUsed = estTokens(`query: ${task}\n`);
  const selected = new Set<string>();
  let truncated = false;

  for (const h of hits) {
    if (selected.has(h.symbol.id)) continue;
    const sig = h.symbol.sig.slice(0, MAX_SIG);
    const hit: CapsuleHit = {
      handle: "",
      name: h.symbol.name,
      kind: h.symbol.kind,
      file: h.symbol.file,
      line: h.symbol.nameLine,
      sig,
      reason: h.reason,
      conf: h.conf,
    };
    const cost = estTokens(`${hit.name} ${sig} ${h.symbol.file}:${h.symbol.nameLine}`);
    if (tokensUsed + cost > budgetTokens) {
      truncated = true;
      if (capsHits.length === 0) {
        capsHits.push({ ...hit, handle: mkHandle(capsHits.length) });
        tokensUsed += cost;
      }
      break;
    }
    selected.add(h.symbol.id);
    hit.handle = mkHandle(capsHits.length);
    capsHits.push(hit);
    tokensUsed += cost;
  }

  return {
    query: task,
    root: build.root,
    gitHead: build.gitHead,
    workingTree: build.treeHash,
    budgetTokens,
    tokensUsed,
    truncated,
    files,
    entryPoints,
    hits: capsHits,
    unresolvedTerms,
    next: [
      ...capsHits.slice(0, 3).map((h) => `context expand ${h.handle}`),
      ...capsHits.slice(0, 3).map((h) => `context impact ${h.name}`),
    ],
  };
}

export function mkHandle(i: number): string {
  return `src-${String(i + 1).padStart(2, "0")}`;
}

function terms2(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) out.add(m[0]);
  return [...out];
}
