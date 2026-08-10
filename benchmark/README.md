# Context benchmark harness

Paired evaluation per `meta/cross-product/context-benchmark-plan.md`. Drives
**opencode** with **DeepSeek V4 Flash** (`opencode-go/deepseek-v4-flash`),
billed at **2x usage** — the multiplier is applied to all token and cost
accounting and is set in `manifest.yaml`.

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

## Frozen-fixture note

`manifest.yaml` ships two **sample** tasks on the spike fixtures so the harness
is runnable. The real Phase-0 fixture (5 Graft-style + 5 Terminal-Bench 2.1
tasks with pinned revisions and golden locations) replaces them before any
published result.
