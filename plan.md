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
- `bun run bench` is now a truthful shared-retrieval observation ablation. It
  reports 100% directory/trail recall on ordinary fixture tasks, but the
  full RepoMap/trails observation exceeds the 1200-token budget on 15/23 tasks
  (map on 3/23). This is the current release blocker.

## Open work

### 1. Make observation variants fit one budget

Keep `bench` as an idea checker: retrieval is intentionally shared, while
flat, DirMap, RepoMap, and trails vary the observation surface. Reduce or
prioritize map/trail output so every variant fits the same declared budget, or
define explicit follow-up-call budgets and report them separately. Do not count
the current over-budget trails variant as shipped.

### 2. Extend evaluation beyond retrieval presence

`eval` and `bench` currently cover file/symbol recall, directory recall, trail
recall, token budgets, and dirty-tree cases. Add permanent per-task checks for:

- exact evidence-range recall;
- unrelated items in the capsule;
- follow-up operations needed to reach evidence;
- cold/warm latency and cache size.

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
