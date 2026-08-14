# Context plan

## Current position

Context is a deterministic repository-discovery compiler. It scans a repository,
extracts symbols and relationships, ranks relevant code and documents, and emits
a compact navigation capsule for an agent.

The original five phases are implemented in the working tree. The foundation
now includes:

- repository-scoped, atomic, fail-open cache and hook state;
- validated CLI targets, cross-platform installers, and a source fallback when
  the standalone Bun binary cannot run;
- a reproducible retrieval evaluation harness;
- graph and lexical ranking with SQLite FTS5/BM25;
- local, opt-in semantic fallback;
- text extraction for Markdown, office documents, OpenDocument, RTF, EPUB, and
  PDF files; and
- configuration stored outside the repository.

The next work should improve demonstrated user outcomes, not add more retrieval
machinery by default.

## Vector 1 — Release and runtime parity

Source-level tests are not enough if an installed launcher or compiled artifact
can run older or behaviorally different code.

- Add build identity and cache-schema information to `context --version`.
- Test the built artifact and installed launcher, not only `src/cli.ts`.
- Run cache-failure, concurrent-write, initialization, and `prepare` smoke tests
  against a clean local installation.
- Make semantic support consistent across the compiled and Bun-source runtimes,
  or make the supported runtime boundary explicit and test it.

Done when a clean checkout can build, install, and run the same verified feature
set, and the installed command passes the fail-open cache test.

## Vector 2 — Evaluation credibility

The fixture suite is useful for regression testing, but its near-perfect scores
do not establish retrieval quality on unfamiliar repositories.

- Build a small, reviewed task set from pinned revisions of real repositories
  and real documents.
- Record expected files and symbols, query type, acceptable top-`k`, and why each
  answer is relevant.
- Report baseline, BM25, and semantic results on the same corpus, including
  per-task regressions rather than only aggregate scores.
- Keep a fast, deterministic subset in CI and publish the heavier benchmark's
  corpus manifest, seed, environment, and raw results.
- Measure capsule usefulness with agent tasks in addition to retrieval metrics;
  Recall@5 and MRR are proxies, not the product outcome.

Done when a retrieval change can be accepted or rejected from reproducible
real-data evidence, with no unexplained regression on authoritative path,
symbol, or changed-file queries.

## Vector 3 — Hard-query retrieval

Use the real-data benchmark's misses to drive improvements. The known weak
slices are disjoint paraphrases and long, cross-format documents.

- Preserve a failure corpus for every confirmed miss before changing ranking.
- Index long documents by bounded sections or pages instead of one truncated
  record, while retaining source locations for expansion.
- Compare query routing, record construction, and small local embedding models
  on the hard slices before changing the default model.
- Keep graph, explicit-path, and changed-file evidence authoritative; semantic
  matches remain a fallback.
- Ship only changes that improve the target slice within declared latency,
  memory, and index-size budgets.

Done when the hard slices improve on the pinned real corpus without degrading
deterministic queries or making network access mandatory.

## Vector 4 — Scale and incremental correctness

Measure behavior on repositories large enough to expose resource and
invalidation problems.

- Track cold and warm p50/p95 latency, peak memory, cache size, index size, and
  document-conversion time by repository size.
- Reuse extracted documents by content identity, not only size and modification
  time, so same-size or timestamp-preserving edits cannot leave stale text.
- Bound parsing, conversion, and semantic work independently; cancellation and
  timeout paths must still emit valid fail-open output.
- Add a large-repository regression fixture that exercises incremental code and
  document updates without relying on live downloads.

Done when published budgets hold on the pinned large corpus and every content
change invalidates the relevant cached record.

## Non-goals

- No remote vector database.
- No answer generation inside Context.
- No silent network calls during repository discovery.
- No broad agent-framework orchestration.

## Release gate

Context is ready for wider use when:

1. the built and installed commands pass the same clean-environment smoke suite;
2. real-repository retrieval results are reproducible and regression-gated;
3. hard paraphrase and cross-format slices meet explicit quality budgets; and
4. large-repository latency, memory, cache, and invalidation budgets pass.
