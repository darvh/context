# Current implementation review

Date: 2026-08-15

## Verdict

The implementation is substantially cleaner than the previous review. The
temporary fusion and semantic experiment scripts are staged for deletion, the
semantic tuning surface was removed, document-only directories are represented,
caller/callee direction is rendered, and the full test suite is green.

The remaining blocker is observation compression: RepoMap and especially graph
trails exceed the single 1200-token budget on the current benchmark corpus.

## Evidence

- Type-check: pass.
- Tests: 83 pass, 0 fail.
- Fixture eval: baseline file recall 91.3%, hybrid file recall 95.7%; MRR
  0.783 → 0.826; 0/23 capsule budget violations.
- Bench: shared retrieval is intentional and correctly reported separately from
  observation variants. Ordinary directory/trail recall is 100%, but map is
  over budget on 3/23 tasks and trails on 15/23.
- Semantic needle coverage: `g-needle-1` and `p-needle-1` hit; `t-needle-1`
  remains a miss under the current embedding model.

## Findings

### P1 — Trails exceed the declared Observe budget

The current bench correctly applies one 1200-token budget. The trails variant
exceeds it on 15 of 23 tasks, and the map variant exceeds it on 3. The
observation progression is therefore not yet safe to ship as a default capsule.

Disposition: trim trails by depth/count, select only the highest-value trail,
or make follow-up calls explicitly separate from the initial Observe budget.
Keep the over-budget rows as regression tests.

### P2 — Exact evidence is not yet an evaluation metric

The task schema contains edges and locations in the plan, but the current
evaluation output primarily measures file/symbol presence, directories, trails,
and tokens. A result can pass retrieval recall while expanding to the wrong
range or requiring unnecessary follow-up operations.

Disposition: add expected evidence ranges and measure whether `expand` reaches
them, plus unrelated capsule items and calls-to-evidence.

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

- Keep `eval` as the deterministic regression gate.
- Keep `bench` as the observation idea checker; its shared-retrieval design is
  now explicit and its budget failures are actionable.
- Do not ship the old RRF or semantic tuning experiments; they are staged for
  deletion.
- Keep `observe`/`prepare`, directory `map`, `follow`, `expand`, and `impact`.
- Keep `find` and `map <symbol>` removed.

## Next review gate

Reduce the trails/map capsule to the declared budget, add exact-evidence checks,
run pinned real-repository eval, and perform a small paired-agent sample. A
retrieval or fusion change ships only with measured improvement and no
unexplained per-task regression.
