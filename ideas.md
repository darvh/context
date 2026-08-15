# Local code-and-doc retrieval ideas

## Design target

Context should be a local observation compiler, not generic RAG:

```text
structured evidence
  → exact facts
  → hierarchical hybrid retrieval
  → minimal graph neighborhood
  → novelty-aware budget packing
  → exact expansion
```

The system should remain local, inspectable, deterministic on its exact lanes,
and useful before an agent edits code.

## Retrieval vectors

### 1. Diagnostic-first retrieval

Parse structured evidence before normal search:

- stack frames;
- compiler/type-check errors;
- exception messages;
- log fragments;
- failing test names;
- routes, environment variables, and SQL identifiers;
- issue references and file-line locations.

```text
query → structured evidence → exact files/symbols/tests → graph neighborhood
      → semantic fallback only if unresolved
```

This should dominate embeddings for debugging tasks.

### 2. Typed artifact graph

Expand the graph beyond symbols:

```text
env variable → reader → config loader
route → handler → service
table → migration → model → query
CLI flag → parser → config field
JSON key → schema → consumer
endpoint → API spec → implementation
build target → source package
```

Extract facts from manifests, schemas, migrations, configuration, string
literals, API specifications, and build files.

### 3. Minimal connecting subgraph

Given the strongest 3–5 seeds, find the smallest graph connecting them instead
of rendering independent trails:

```text
handler → service → store
                    ↘ config
```

Use bounded shortest paths, confidence-weighted edges, and a novelty penalty.
Emit only the minimal explanation required to connect the seeds.

### 4. Session-delta retrieval

Remember what the agent has already seen during the current task:

```text
first observe: directories + primary neighborhood
second query: only new symbols/relationships
follow: only unseen trail steps
expand: exact evidence
```

Use a disposable task/session cache keyed by handles. Do not create persistent
user profiling or learned memory.

### 5. Calibrated confidence and abstention

Replace a single fixed score threshold with deterministic features:

- authoritative signal present;
- meaningful-term coverage;
- top-1/top-2 score margin;
- agreement between lexical, BM25, graph, and semantic lanes;
- candidate count and directory concentration.

Return one of:

```text
strong      skip semantic and emit
uncertain   run semantic/reranker
conflicted  show alternatives
empty       report no evidence
```

Only learn calibration after enough real annotated tasks exist.

### 6. Hierarchical dense retrieval

Use dense retrieval coarse-to-fine:

```text
query → directories/packages → files → symbols/sections
```

Exact and authoritative hits may bypass the hierarchy. This reduces semantic
noise and scales better than comparing every query with every symbol.

### 7. Multi-view symbol records

Represent symbols through several deterministic views:

```text
identity: name + signature + path
behavior: called symbols + accessed fields + returned types
runtime: errors + log strings + config keys
tests: test names + assertions targeting the symbol
```

Retrieve by the best view but return one symbol. Do not generate prose
summaries solely for embedding.

### 8. Repository-vocabulary query expansion

For weak queries, expand terms using the repository itself:

```text
“remember values after restart”
  → persist, storage, database, openStore, session
```

Use names from top directories, import aliases, document headings, config keys,
and neighboring symbols. Run one bounded second retrieval pass. Avoid
unrestricted LLM rewriting.

### 9. Git-history lane

For explicit history, regression, ownership, or “why did this change?” tasks,
use:

- co-change relationships;
- recent commits touching a symbol;
- rename history;
- blame-linked tests;
- files historically changed together.

Never let co-change influence ordinary topical retrieval unless the query asks
for it.

### 10. Negative constraints

Parse exclusions and scope restrictions:

```text
production code, not tests
Python implementation
without the legacy adapter
only config under packages/auth
```

Apply these as filters or penalties before ranking. Positive relevance alone is
not enough for precise agent navigation.

## Retrieval algorithm

```text
1. Parse query intent
   exact path / identifier / concept / documentation / dependency / history

2. Extract structured evidence
   diagnostics, stack frames, test names, routes, config keys, issue IDs

3. Authoritative retrieval
   exact paths, symbols, SCIP/LSP facts, changed affinity

4. Sparse retrieval
   BM25 over symbols, artifacts, and document sections

5. Confidence gate
   strong → skip dense retrieval
   weak/empty → run local embeddings

6. Hierarchical candidate union
   directories → files → symbols/sections

7. Typed graph expansion
   callers, callees, tests, config, docs, schemas, routes, migrations

8. Minimal connecting subgraph
   retain only relationships needed to explain the selected neighborhood

9. Novelty-aware budget packing
   emit only information not already seen in the task session

10. Exact handles
    map, follow, and expand remain deterministic follow-up operations
```

## Model and index policy

- Keep BM25 and the exact graph as the default.
- Keep dense retrieval opt-in and fail-open.
- Use linear vector search until measured latency requires ANN; do not add a
  vector database preemptively.
- Consider late interaction only if single-vector retrieval demonstrably fails
  on real tasks and the index-size cost is acceptable.

## Do not build yet

- Full GraphRAG or graph embeddings.
- A vector database for ordinary repository sizes.
- More RRF/query-expansion knobs without a non-regression result.
- LLM-generated repository summaries.
- Semantic edges between every document and symbol.
- Autonomous retrieval loops inside Context.
- Per-repository embedding fine-tuning before enough labeled tasks exist.

## Priority order

```text
P0  diagnostic-first retrieval
P1  typed artifact graph
P1  minimal connecting subgraph
P1  session-delta retrieval
P2  calibrated confidence
P2  hierarchical dense retrieval
P2  multi-view symbol records
P2  repository-vocabulary expansion
P3  Git history and negative constraints
P4  late interaction / SPLADE / ANN
```

## Proof requirements

Every idea must be evaluated per task, not only in aggregate:

- file and symbol recall;
- directory and edge recall;
- exact evidence-range recall;
- relevant items per serialized token;
- repeated-information rate across a session;
- cold/warm latency and index size;
- task success and time-to-first-correct-edit on paired agent tasks.

No vector ships unless it improves the relevant metric without unexplained
regressions on authoritative path, symbol, change, and exact-evidence tasks.

## References

- [SCIP Code Intelligence Protocol](https://github.com/sourcegraph/scip/)
- [SCIP protocol reference](https://github.com/sourcegraph/scip/blob/main/docs/scip.md)
- [LocAgent: Graph-Guided LLM Agents for Code Localization](https://arxiv.org/abs/2503.09089)
- [Repoformer: Selective Retrieval for Repository-Level Code Completion](https://arxiv.org/abs/2403.10059)
- [RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and Generation](https://arxiv.org/abs/2303.12570)
- [Qwen3 Embedding](https://github.com/QwenLM/Qwen3-Embedding)
- [Qwen3 Embedding paper](https://arxiv.org/abs/2506.05176)
- [ColBERTv2](https://aclanthology.org/2022.naacl-main.272/)
- [Jina-ColBERT-v2](https://aclanthology.org/2024.mrl-1.11/)
