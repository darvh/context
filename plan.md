# Context plan

## Product thesis

Context is a deterministic observation compiler for coding agents.

Its primary job is not generic semantic search or answer generation. Its job is
to give an agent a small, source-backed mental model of the repository before
the agent starts exploring:

```text
Observe → Map → Follow → Pinpoint
```

The first output should be compressed orientation. Exact source and document
evidence should be retrieved only after the agent has selected a neighborhood.

The design target is Graft-like navigation memory, implemented from repository
facts rather than generated prose:

```text
repository
  ↓
directory map
  ↓
query neighborhood
  ↓
graph trails
  ↓
exact evidence
```

No remote vector store, answer generation, or broad agent orchestration is part
of Context.

## Current baseline

The current implementation is a useful RepoMap prototype with a thin graph and
document lane:

- Tree-sitter and generic extraction produce symbols, spans, imports, and
  edges.
- `resolveFacts` builds an in-memory symbol graph.
- lexical matching, graph propagation, BM25, and optional local semantic search
  produce ranked hits.
- AnyDoc converts supported office/PDF formats to text outside the code graph.
- external content-addressed caching makes warm and incremental builds cheap.
- `prepare`, `expand`, and `impact` are the current agent-facing operations.

Observed baseline on this checkout:

| measurement | observed result |
| --- | --- |
| self-index cold build | about 282 ms |
| self-index warm prepare | about 105 ms |
| repository scanned | 100 files |
| extracted symbols | 1,565 |
| graph edges | 5,736 |
| warm incremental parse | 0 files when unchanged |
| one-file edit | 1 file reparsed |
| focused ranking tests | 2 pass, 0 fail |
| spike cold fixtures | 18–30 ms per small fixture |
| spike warm query | about 14–16 ms |
| spike incremental refresh | under 1 ms |
| spike hook | about 75–80 ms |

These numbers establish that the deterministic substrate is fast enough for an
MVP. They do not establish that the capsule is useful to an agent.

Important baseline failures:

1. A 500-token request produced roughly 2,136 output tokens in JSON. The
   assembler accounts for hit labels and signatures, but not all rendered
   reasons, paths, next actions, and serialization overhead.
2. A query about office-document conversion returned many unrelated symbols
   from currently changed files. `recent-change` currently makes every symbol
   in a changed file relevant and can dominate topical retrieval.
3. There is no semantic directory map. `files` is only the top files aggregated
   from ranked symbol hits.
4. Expansion uses a small line window around the symbol name instead of the
   recorded source span.
5. Document hits are synthetic line-one symbols over a whole, bounded document;
   they cannot provide section/page-level pinpoint evidence.
6. Ambiguous symbol names can resolve to the first candidate rather than a
   qualified identity.

These are the baseline to beat. New retrieval machinery is not justified until
these correctness and compression problems are fixed.

## Progress

- Vectors 1–2 done. Budget is now measured on the final serialized form (both
  renderings, `max(text, json)`) with deterministic drop order (entry points →
  unresolved → files → changed → next → hits); `tokensUsed` is the real
  serialized cost including its own literal, measured to fixpoint. Recent-change
  is affinity-gated (topical match, explicit path, or a recent-work query);
  changed files land in a bounded `changed` capsule section instead of ranking.
  Baseline failures 1 and 2 reproduced, then fixed; regression gates added
  (truthful-budget and dirty-tree tests, eval budget-violation checks, dirty
  fixture `cmd/migrate/migrate.go` with zero topical affinity).
- Vectors 3–6, 8 done. DirMap L0 (`src/dirmap.ts`) ranks directories by task
  affinity, never symbol count, and appears as the capsule `dirs` section.
  Neighborhood RepoMap (`src/repo-map.ts`, `context map <dir|symbol>`) and
  graph trails (`src/follow.ts`, `context follow <symbol> <edge>`) compile a
  bounded local map from the cached graph per request. Symbol identity is
  navigation-safe: ambiguous bare names surface qualified candidates
  (`file::name::line`) instead of silently picking the first. Every hit now
  carries its full source range and `context expand` returns the recorded span
  with bounded context. Doc hits carry section ordinal and heading. Ops:
  `observe`/`find`/`prepare` (orientation), `map`, `follow`, `expand`,
  `impact` (qualified-id aware).
- Bench replaced: `scripts/bench.ts` is the variant idea checker (flat /
  DirMap / +RepoMap / +trails) over the pinned eval corpus, reporting per-task
  file/dir/trail recall and token deltas. Disposable spike wrappers removed
  (`spike/bench.ts`, `spike/results.json`, `spike/context-bin`, `spike/src`);
  the runtime decision is a note in `spike/README.md`; `spike/grammars` stays
  (bundled by the compiled binary).
- Measured after the fix: eval serialized tokens 1041–1045 avg vs 1200 budget,
  0/19 violations; all dirty-tree tasks recall 100% with no regression on the
  previous 14 tasks; 80 unit tests pass. Variant runner: 19/19 tasks at 100%
  file/dir/trail recall in every variant, +122 avg tokens for the full
  pipeline (1058 → 1180). The bm25 lane also stopped re-admitting import
  symbols as hits (they were never supposed to be targets; the truthful budget
  exposed it).
- Not yet done: Vector 7 doc section structure is mostly present (sections
  with lines); exact heading-path retrieval for converted office docs still
  needs the section-ordinal/char-range depth. Release-gate item 9 (paired
  agent tasks) is the next external step.

## Observation contract

`observe(task, budget)` should produce a bounded capsule containing:

1. repository identity and runtime/build facts;
2. current working-tree context, shown separately from task relevance;
3. a compact hierarchical directory map;
4. one to three likely task neighborhoods;
5. a small query-specific RepoMap inside those neighborhoods;
6. two or three useful graph trails;
7. unresolved terms and the next deterministic operation.

The Observe capsule should not contain arbitrary source bodies or a long flat
list of weak hits. It is navigation, not evidence. `find`/`expand` is the
evidence path.

## Improvement vectors

### Vector 1 — Make the budget truthful

Change assembly so the final serialized representation, not an approximation of
the selected labels, is measured against the budget.

Acceptance checks:

- rendered text and JSON each stay within their declared budget;
- truncation is deterministic and preserves the most useful sections;
- telemetry reports the same accounting used for selection;
- a capsule cannot exceed budget merely because explanations or `next` entries
  were added.

Do this before comparing retrieval variants. Otherwise a smaller capsule may
only appear better because its accounting is wrong.

### Vector 2 — Separate change context from topical ranking

Changed files are valuable Observe context, but they are not automatically the
answer to every query.

Keep a bounded `changed` section and apply a recent-change boost only when the
task has affinity with the file, or when the query explicitly asks about recent
work. Preserve direct path and symbol matches as authoritative.

Add dirty-tree regression tasks where unrelated files are modified and the
correct neighborhood must still win.

### Vector 3 — Add DirMap as Observe L0

Derive directory cards from the existing scan, symbols, edges, manifests, tests,
docs, and Git metadata. A card should contain only compact aggregates:

```text
src/auth/
  34 files · TypeScript · authentication subsystem
  public surface: session, token, oauth
  entry points: middleware.ts, service.ts
  tests: tests/auth/
  related: packages/db, docs/auth/
```

Rank directories first, then recurse into only the top few. Do not build a
global prose summary or add an LLM dependency.

Acceptance checks:

- relevant directory appears in the top three for annotated tasks;
- unrelated directories are not emitted merely because they contain many
  symbols;
- directory output fits a small fixed budget;
- the agent can request a deeper map for one directory without rebuilding the
  whole repository.

### Vector 4 — Compile a neighborhood RepoMap

Replace the global flat hit list with a query-specific map inside selected
directories. Cluster by file and role, and enforce diversity across files,
entry points, implementations, tests, and docs.

The map should show signatures and relationships for important symbols only:

```text
src/auth/service.ts
  TokenService.refresh()
    calls → validateRefreshToken()
    tested_by → token-service.test.ts
```

Keep the underlying graph cached; compile a small textual map per query.

### Vector 5 — Make the graph navigation-safe

Retain the current cheap persistent graph, but improve identity and traversal:

- use qualified symbol IDs for navigation;
- never silently choose the first same-name symbol;
- add file and directory nodes;
- expose reverse edges such as callers, implementations, and tests;
- produce short graph trails instead of relying only on global two-hop score
  propagation;
- expand deeper call/data relationships only around the active neighborhood.

The graph is navigation memory. It should explain why a node is present, not
pretend its score is evidence.

### Vector 6 — Make Pinpoint span-backed

Every code hit should carry its complete source range. `expand` should return
the symbol span with optional bounded context, then optionally return callers,
callees, tests, or configuration that are directly relevant.

Every result should include:

```text
path
line range
symbol or document section
confidence
why it matched
relationship, if followed
```

Pinpoint must remain separate from Observe so orientation stays cheap.

### Vector 7 — Preserve document structure

Keep AnyDoc conversion local, but index converted output as structural units:

```text
document → heading → section → paragraph/table
```

Retain source file, heading path, page/slide/sheet when available, section
ordinal, and line/character range. Whole-document records may remain as a
fallback orientation lane; exact retrieval must operate on sections.

### Vector 8 — Improve agent-facing progression

Expose explicit operations with distinct contracts:

```text
observe(task)                 # repository and directory orientation
map(directory-or-handle)      # deeper local map
follow(symbol, edge)          # graph navigation
find(query)                   # exact local evidence
expand(file-or-handle)        # bounded source/document range
impact(symbol-or-diff)        # callers, tests, and changes
```

`map` accepts either a directory or a qualified symbol:

```text
map("src/auth/")
map("src/auth/token.ts::TokenService.refresh::184")
```

`map(directory)` produces a compact local RepoMap. `map(symbol)` compiles a
bounded relationship-centered RepoMap when graph edges exist:

```text
TokenService.refresh()
  callers: AuthController.refresh()
  callees: validateRefreshToken(), rotateSession()
  tests: rejectsExpiredRefreshToken()
  related files: controller.ts, session.ts, token.test.ts
```

It must not dump the whole graph. Start with one hop, group results by file and
role, preserve edge type and confidence, and return handles for `follow` and
`find`. The result is a context compiler over a selected neighborhood, not a
second global search index.

`follow(symbol, edge)` is the lower-level directional traversal primitive. It
should support callers, callees, implementations, inheritance, tests,
configuration, and other known edge kinds, with bounded depth and result count.
`impact` remains a convenience summary built on these relationships.

The current mechanically generated `next` list should become type-aware:
observe a directory when the directory is uncertain, follow an edge when the
symbol is known, and find exact evidence when the question is resolved enough.

## Evaluation strategy

Evaluation must measure compressed observation, not only top-k file retrieval.

Each annotated task should record:

```json
{
  "query": "where are office documents converted to markdown?",
  "directories": ["src"],
  "files": ["src/doc.ts", "src/build.ts"],
  "symbols": ["extractDocText", "build"],
  "edges": [["build", "extractDocText"]],
  "evidence": [["src/doc.ts", 80, 93]],
  "unrelatedChangedFiles": ["src/init.ts"]
}
```

Measure per task and per variant:

- directory recall;
- file and symbol recall;
- required graph-edge/trail recall;
- exact evidence-range recall;
- relevant items per output token;
- actual output tokens;
- unrelated items in the capsule;
- dirty-tree robustness;
- follow-up operations needed to reach evidence;
- cold and warm latency;
- memory and cache size.

Metrics are proxies. A small paired agent-task sample should eventually measure
task success, tool calls, time-to-first-correct-edit, and input tokens. Aggregate
scores must not hide per-task regressions.

## Bench and eval decisions

### Keep and strengthen `eval`

The deterministic evaluator is the regression gate. Keep the pinned real tasks
and fixture tasks, but add directory, edge, span, budget, and dirty-tree
annotations. Keep per-task output and require no unexplained regression on
authoritative path, symbol, change, or exact-evidence queries.

### Replace the current `bench`

The current large benchmark is an idea checker in name but mostly tests the
existing retrieval model. It generates synthetic repositories shaped around the
current tokenizer and ranking lanes, downloads unpinned repositories/documents
in one mode, and scores file presence rather than Observe quality.

Replace it with a small variant runner that compares:

```text
baseline flat hits
DirMap
DirMap + neighborhood RepoMap
DirMap + RepoMap + graph trails
```

All variants must consume the same pinned corpus, annotations, and budget. The
runner should report per-task deltas, not only an aggregate headline.

Synthetic data remains appropriate for invariants such as duplicate symbols,
giant directories, graph cycles, and unrelated dirty files. It should not be
used as the primary product-quality claim.

### Remove the completed feasibility spike

The spike has already answered its runtime question: Bun/TypeScript meets the
small fixture latency targets, while compiled-binary execution needs a real-host
check. Remove disposable spike wrappers and stale results after moving reusable
fixtures into the evaluation area. Preserve the runtime decision as a short
note, not as a second benchmark system.

## Implementation order

1. ✅ Establish the baseline corpus and record the budget, dirty-tree, and
   pinpoint failures above.
2. ✅ Fix truthful budgeting and changed-context pollution.
3. ✅ Implement DirMap and the L0 → L1 → L2 observation progression.
4. ✅ Compile a neighborhood RepoMap with diversity limits.
5. ✅ Make symbol identity and graph trails navigation-safe.
6. ✅ Make code and document expansion span/section-backed.
7. ✅ Replace the current bench with the variant idea checker.
8. ✅ Extend `eval` as the deterministic regression gate.
9. Run paired agent tasks and publish only improvements that survive both
   deterministic and agent-level checks.

## Release gate

Context is ready for broader use when:

1. Observe output is truly within budget;
2. unrelated dirty files do not displace task-relevant neighborhoods;
3. directory and neighborhood discovery are reproducible on pinned real tasks;
4. graph trails and exact spans lead to the correct evidence;
5. document sections are retrievable with source locations;
6. warm/incremental latency remains within the existing budgets; and
7. no new retrieval machinery is retained without a measured improvement.
