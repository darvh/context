# Context plan

## Current position

Context is a deterministic repository-discovery compiler. It scans a repository,
extracts symbols and relationships, ranks relevant code, and emits a compact
navigation capsule for an agent.

The immediate hardening pass is complete:

- Pi uses the shared `~/.agents/skills` and `.agents/skills` locations.
- Repository-boundary checks reject `context expand` paths outside the requested root.
- Symbolic links are excluded from scans.
- Selected-agent reporting is scoped to the selected targets.
- Regression coverage now includes path traversal and symbolic links.
- Current verification: `36 pass, 0 fail`.

## Phase 1 — Cache and hook safety

Make Context safe when several repositories or agents run at the same time.

- Scope cache, capsule, and hook state by repository identity and session.
- Use unique temporary filenames for atomic writes.
- Treat cache failure as a recoverable condition; discovery should still return a
  capsule when the cache directory is unavailable.
- Ensure hook timeout paths clear timers and emit valid fail-open output.
- Add tests for concurrent writes, unwritable cache directories, and two repos
  using the same agent account.

Done when concurrent runs do not overwrite each other and a cache failure does
not fail the user request.

## Phase 2 — CLI and distribution reliability

- Validate `--targets` and fail clearly on unknown agent names.
- Keep CLI help, README, installers, and the target matrix synchronized.
- Remove package scripts for deleted benchmark files, or restore the benchmark
  entrypoints deliberately.
- Make the installed command self-test the compiled binary and fall back to the
  Bun source entrypoint when the host cannot execute compiled Bun binaries.
- Test Bash and PowerShell installers in dry-run and local project modes.
- Reduce unused language dependencies or document why each remains installed.

Done when a fresh checkout can install, initialize, and run `prepare` on a clean
machine with a clear fallback when standalone binaries are unavailable.

## Phase 3 — Retrieval evaluation

Before adding semantic retrieval, create a small golden evaluation set from real
repositories.

Each task should record:

- expected files and symbols;
- whether the task names a path, symbol, concept, or change;
- acceptable top-`k` results;
- cold and warm latency;
- false-positive and empty-result behavior.

Track `Recall@5`, `MRR`, p50/p95 latency, index size, and cache hit rate. Include
paraphrased tasks such as “where does the app remember values after restart?”
and explicit path queries.

Done when retrieval changes can be compared against a fixed baseline.

## Phase 4 — Hybrid local retrieval

Add sparse retrieval before embeddings.

- Index one row per symbol or meaningful declaration.
- Store name, path, signature, documentation, kind, and language.
- Use SQLite FTS5 with BM25 for lexical ranking.
- Fuse lexical rank with the existing graph, changed-file, explicit-path, and
  entry-point signals.
- Preserve deterministic output and expose the reason for each ranking signal.

Do not build a generated-answer RAG layer. Context should retrieve and assemble;
the agent should reason over the capsule.

Done when hybrid retrieval improves the evaluation set without exceeding the
latency and size budgets.

## Phase 5 — Optional semantic fallback

Only add embeddings if Phase 3 shows that hybrid lexical retrieval misses useful
paraphrases.

- Run embeddings only for unresolved or low-confidence queries.
- Embed symbol-level records, not arbitrary large file chunks.
- Keep the model optional and local; do not require a hosted API.
- Version the model and embedding schema in the cache key.
- Make privacy, model download size, latency, and failure behavior explicit.

Semantic retrieval is a fallback signal, not the primary source of truth. Graph
relationships, paths, changes, and source evidence remain authoritative.

## Non-goals

- No remote vector database.
- No answer generation inside Context.
- No silent network calls during repository discovery.
- No broad agent-framework orchestration.

## Release gate

Context is ready for wider use when:

1. boundary and symlink tests pass;
2. concurrent cache and hook tests pass;
3. CLI and installers pass clean-machine checks;
4. retrieval has a reproducible baseline and measured improvement;
5. standalone binary failure has a documented, tested fallback.
