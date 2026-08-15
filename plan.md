# Context plan

## Product thesis

Context is a deterministic observation compiler for coding agents. It compresses
a repository into a source-backed mental model before editing:

```text
Observe → Map → Follow → Pinpoint
```

The public operations are `observe`/`prepare`, `map <directory>`, `follow`,
`expand`, and `impact`. `find` and `map <symbol>` remain removed because they
duplicate existing operations.

## Current implementation

- Tree-sitter/generic extraction produces spans, imports, and a resolved graph.
- Lexical ranking, bounded graph propagation, BM25, and optional local semantic
  fallback produce ranked hits.
- AnyDoc converts office/PDF files locally; long documents are indexed as
  bounded sections with ranges.
- External content-addressed caching supports warm and incremental rebuilds.
- DirMap includes code and document-only directories.
- `follow` renders caller/callee direction and qualified-id ambiguity safely.
- Semantic tuning experiments have been removed; production keeps one bounded,
  opt-in semantic configuration.

The semantic path is:

```text
lexical + BM25 → confidence gate → local embeddings
             → semantic symbols/directories → bounded capsule context
```

Strong lexical or authoritative path/change signals skip embedding work.
Semantic document hits select a matching section before expansion.

## Current evidence

- `bun run typecheck`: passes.
- `bun test`: 83 pass, 0 fail.
- Fixture eval: graph/lexical file recall 91.3%; hybrid graph+BM25 95.7%;
  MRR improves 0.783 → 0.826; zero capsule budget violations.
- The remaining fixture miss is the known semantic needle task
  `t-needle-1`; the current embedding model ranks `src/index.ts` instead of
  `src/session/store.ts`.
- `bun run bench` is a truthful shared-retrieval observation ablation with
  declared per-variant budgets: observe (flat/dirmap) 1200 tokens, follow-up
  calls map 400 and trails 400. All 23 tasks are within budget (flat 0/23,
  dirmap 0/23, map 0/23, trails 0/23 over); directory/trail recall is 100% on
  ordinary tasks. The only flag is the known semantic ceiling `t-needle-1`.
- `eval` measures exact-evidence-range recall per task: 93.5% baseline, 97.8%
  hybrid. Known gap: `g5`'s `Store` struct span ranks below top-5 (the
  capsule surfaces `Get`/`OpenStore` spans instead; the struct is reachable
  via `impact`).
- Compiler-backed graph overlay: a binary SCIP index (`index.scip`,
  `@c4312/scip` protobuf) or a documented JSON facts file
  (`.context/facts.json`) merges into the tree-sitter graph — exact
  definitions/references/implementations upgrade confidence; tree-sitter
  behavior is unchanged when no overlay exists. Reference edges come from
  occurrences inside an enclosing definition (containment, else nearest
  preceding). Pinned permanently: the TS fixture ships a generated
  `index.scip`, so eval exercises the overlay.
- Budget-aware context packing: the capsule is selected by utility per
  serialized token (relevance × confidence × novelty) with authoritative pins
  first and minimal orientation guaranteed; replaced fixed
  "append-then-drop" composition. Same recall/evidence, leaner output, and
  novelty spreads hits across files.

## Open work

### 1. Extend evaluation beyond retrieval presence

`eval` and `bench` now cover file/symbol recall, directory recall, trail
recall, exact-evidence-range recall, token budgets per declared variant,
dirty-tree cases, and cold/warm latency with cache and index size
(`scripts/eval.ts` reports cold/warm p50/p95, index bytes, cache hits).
Still missing permanent per-task checks for:

- unrelated items in the capsule;
- follow-up operations needed to reach evidence.

Keep per-task regressions authoritative; aggregate scores are only summaries.

### 3. Validate semantic retrieval honestly

Run the optional semantic lane on pinned real repositories and a small paired
agent-task sample. Measure task success, tool calls, time-to-first-correct-edit,
and input tokens. Treat the `t-needle-1` miss as a model/corpus ceiling until
new evidence justifies a change. Do not reintroduce removed tuning knobs or
retain a new fusion strategy without measured improvement.

### 4. Complete real-world release checks

Run `bun run eval -- real` against the pinned revisions after the current staged
cleanup. Confirm compiled-runtime semantic degradation, warm/incremental
latency, and clean-environment smoke behavior on a real host.

## Deliberately not done

- **Reranker bakeoff: measured, rejected.** Qwen3-Embedding-0.6B (ungated
  ONNX mirror `onnx-community/Qwen3-Embedding-0.6B-ONNX` via `CONTEXT_MODEL`)
  was compared to MiniLM on the three needle tasks: identical recovery (2/3),
  same ceiling task missed — the 0.6B model produces stronger similarities
  (0.6+ vs 0.2) but does not surface symbols MiniLM missed. Decisively, a
  reranker reorders candidates and cannot recover a symbol retrieval missed:
  `t-needle-1` is a candidate-generation miss (store.ts never enters top-10),
  so Qwen3-Reranker over Qwen3-Embedding is structurally incapable of fixing
  the one measured gap. Revisit only if a miss classified as ordering failure
  appears.
- **SCIP index auto-generation.** Context consumes `index.scip` when a repo
  ships one (or `.context/facts.json` from any indexer) but never generates
  one: per-language compiler indexers would add heavy deps, network fetches,
  and spawn overhead — against the deterministic, no-network, fail-open
  contract. Tree-sitter extraction is Context's own index; SCIP is a precision
  upgrade on repos that already have it. A hint command could be added later,
  nothing more.
- **Vector DB / GraphRAG / more fusion knobs / LLM summaries / autonomous
  retrieval loops** — rejected per the hypothesis experiments.

## Acceptance gate

The next revision is acceptable when:

1. Every declared Observe variant stays within its declared budget.
2. Dirty files do not displace task-relevant neighborhoods.
3. File, symbol, directory, edge, and exact-evidence metrics are measured per
   task.
4. Caller/callee direction and ambiguous symbol identity remain explicit.
5. Document-only directories and semantic document sections remain navigable.
6. Real-repository and paired-agent checks show no unexplained regression.
7. No benchmark or retrieval mechanism remains without measured improvement.
