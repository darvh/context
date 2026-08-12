# Context benchmark harness

Paired evaluation per `meta/cross-product/context-benchmark-plan.md`. Drives
**opencode** with **DeepSeek V4 Flash** (`opencode-go/deepseek-v4-flash`).

## Cost accounting (true API pricing)

Token usage is provider-reported via `step_finish`: `tokens.input` is the
cache-miss input, `tokens.cache.read` the cache-hit input, `tokens.output` the
output (total = input + cache.read + output). Cost is computed from the price
schedule in `manifest.yaml`:

```text
input cache-miss $0.14 / 1M
input cache-hit  $0.0028 / 1M   (98% off)
output           $0.28 / 1M     (set output_per_1m to the actual rate)
cache writes     free
```

A `usage_multiplier` (2x) applies to reported token counts per the billing
assumption; costs derive from those tokens at the schedule above.

## Arms

- `cold` — plain `opencode run` with the task prompt.
- `context` — same, with a Context structural capsule block prepended (the
  UserPromptSubmit-equivalent; dedupe/injection mechanics live in `src/hook.ts`).
- `graft-structural`, `graft-deep`, `context-semantic` — reserved; run over the
  same manifest once available.

## Layout

```text
benchmark/
  manifest.yaml     # frozen fixture contract: model, arms, tasks, golden locations
  run.ts            # orchestrator: copy repo -> run opencode -> capture transcript
  metrics.ts        # transcript -> per-run metrics (tokens, first-relevant, first-edit)
  report.ts         # results.csv, summary.md, failure-analysis.md
  raw/<arm>/<task>/<run>.jsonl   # full opencode event transcripts
```

## Run

```text
bun run benchmark/run.ts --dry                  # print the plan, run nothing
bun run benchmark/run.ts                        # all enabled arms, manifest reps
bun run benchmark/run.ts --arms context --tasks sess-go --reps 1   # one cell
```

Outputs land in `benchmark/` (override with `--out DIR`).

## Metrics captured

Verified success (task `verify_cmd` exit), first-relevant-location recall
(golden `file:line` mentions in the transcript), time to first relevant, time
to first edit, exploration tool calls before first edit, provider-reported
input/output/cache tokens, cost, wall time, capsule size, failure category.

Token accounting is provider-reported via `step_finish` events. All values are
already `x2` per the usage multiplier. `summary.md` reports medians; individual
runs live in `results.csv`; every miss is classified in `failure-analysis.md`.

## Repo ownership and portability

- **proof bench lives in the `proof` repo** (`proof/bench`, `proofbench`); **context
  bench lives in the `context` repo** (`benchmark/`). They are separate products
  with separate harnesses.
- **The final combined (context + proof) comparison and its reports live ONLY
  in the `context` repo.** The proof repo's bench stays self-contained.
- Cross-system: no hardcoded paths in committed code — everything resolves via
  `import.meta.dir`, `homedir()`, `XDG_*`, or relative paths, so a fresh
  `git clone` works anywhere. Scratch/jobs/cache live under the OS cache dir,
  never in the repo. API keys are never written to the repo (scrubbed in place,
  guarded).
- A note to honor: if the combined arm proves out, do not migrate proof's
  harness into context or vice versa — keep them in their home repos and
  publish only the final paired comparison here.

## Frozen-fixture note

`manifest.yaml` ships two **sample** tasks on the spike fixtures so the harness
is runnable. The real Phase-0 fixture (5 Graft-style + 5 Terminal-Bench 2.1
tasks with pinned revisions and golden locations) replaces them before any
published result.
