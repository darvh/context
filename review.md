# Current implementation review

Date: 2026-08-15

## Verdict

The implementation is substantially cleaner than the previous review. The
temporary fusion and semantic experiment scripts are deleted, the semantic
tuning surface was removed, document-only directories are represented,
caller/callee direction is rendered, and the full test suite is green.

The observation budget blocker is resolved: observe variants and the map/trails
follow-up calls now have declared per-variant budgets, and every task is within
budget. Exact-evidence-range recall is now a measured eval metric.

## Evidence

- Type-check: pass.
- Tests: 83 pass, 0 fail.
- Fixture eval: baseline file recall 91.3%, hybrid file recall 95.7%; MRR
  0.783 → 0.826; exact-evidence recall 93.5% baseline / 97.8% hybrid;
  0/23 capsule budget violations.
- Bench: declared budgets per variant — flat/dirmap 1200, map 400, trails 400;
  0/23 tasks over budget in every variant. Directory/trail recall 100% on
  ordinary tasks.
- Semantic needle coverage: `g-needle-1` and `p-needle-1` hit; `t-needle-1`
  remains a miss under the current embedding model.

## Findings

### P2 — Evidence recall has one known gap

The new evidence metric is honest: `g5`'s `Store` struct span ranks below
top-5 (the capsule surfaces `Get`/`OpenStore` spans; the struct is reachable
via `impact`). Tracked, not a regression — the metric's first measurement.

### P2 — Semantic quality has a model ceiling

The semantic needle task `t-needle-1` still misses the expected session store,
while two analogous paraphrase tasks hit. This is useful evidence, but not a
reason to add another fusion knob without paired-task or pinned-real-repo
improvement.

Disposition: validate on real repositories and agent tasks; keep the current
single bounded configuration until a change wins per-task gates.

### P2 — Real-host release evidence is still pending

The current refreshed evidence is fixture-based. The pinned real-repository
evaluation and compiled-runtime/smoke checks still need to be rerun after the
staged cleanup.

## Decisions

- Keep `eval` as the deterministic regression gate; evidence-range recall is
  now a per-task metric.
- Keep `bench` as the observation idea checker with declared per-variant
  budgets (observe 1200; map/trails follow-up calls 400 each).
- Do not ship RRF or semantic tuning; the experiments are deleted and their
  rejected findings recorded in plan.md.
- Keep `observe`/`prepare`, directory `map`, `follow`, `expand`, and `impact`.
- Keep `find` and `map <symbol>` removed.

## Next review gate

Add the remaining eval metrics (unrelated capsule items, calls-to-evidence,
latency/cache size), run pinned real-repository eval, and perform a small
paired-agent sample. A retrieval or fusion change ships only with measured
improvement and no unexplained per-task regression.
