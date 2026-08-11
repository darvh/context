# Context + Proof combined benchmark plan

## The shared bench idea

Both benches are the same driver: a paired, per-task opencode run on a fresh
task copy, same model, same arms, official verifier.

```text
context bench:  arms cold | context-capsule   verifier = task verify_cmd
proof bench:    arms A (no proof) | B (with proof)  scorer = obligations + hidden tests
combined:       arms cold | context | context+proof  verifier = tests AND proof disposition
```

Once the driver is solid in one repo it is portable to the other. The combined
bench lives in the **context** repo (per Darvh's direction) and imports proof's
fixture contract (`proof/bench` Task record) plus the `proof` binary as the
verification oracle. Context stays runnable without proof; the combined arm
only exists when `proof` is present.

## Obligation derivation — benchmark vs production

- **Benchmark: LLM-only.** Obligations are derived from the task intent by
  the same model doing the work. This is the worst case for circularity
  (self-derived obligations can miss the same thing twice) and deliberately
  so — the benchmark is a conservative floor.
- **Production: human + LLM, ~20/80.** The human anchors the 20%: intent,
  policy, and the obligation classes that matter. The LLM operationalizes the
  80%: turning those anchors into concrete obligations, collecting evidence,
  and reporting disposition.
- Consequence: if the combined arm passes with LLM-only derivation, the
  human+LLM path is expected to be at least as strong on derivation quality.
  A measured helps-signal in the bench is a lower bound on real-world value,
  not a ceiling — and a weak bench result isolates a real derivation gap the
  human anchor would need to close.

## Sequencing — what "all done" means before the combined arm

Phase A (this repo, no proof):
1. Context bench hardening: process-group kill on hang, scratch outside the
   repo, `--replay`, true-cost accounting with cache pricing — done.
2. Real Terminal-Bench 2.1 fixture via Harbor (`benchmark/harbor.ts`): needs a
   docker host; official verifier inside each task image; cold arm only.
3. Mileage: bounded concurrency of opencode cells (see below).
4. Freeze the 5 Graft-style tasks + 5 TB2.1 tasks in the manifest.

Exit: cold vs context shows discovery savings with verified success
non-inferior on the frozen fixture.

Phase B (combined):
5. Author a proof packet (`.proof.yml` + obligations) per fixture task,
   following `proof`'s bench Task classes: helps / both-succeed / both-fail /
   can-hurt.
6. Add the `context+proof` arm.
7. Re-run the same frozen fixture with the same accounting.

## Combined arm design

```text
arm context+proof:
  prompt = capsule_block + "\n" + PROOF_packet + "\n" + task.intent
  where  capsule_block = context prepare output (as arm `context`)
         PROOF_packet  = proof spec for the task (policy + REQUIRED obligations)
  verify = task.verify_cmd AND proof verify (obligations disposition, hidden
           tests applied at scoring only — never during agent work)
  success = tests pass AND every REQUIRED obligation has evidence
```

- The agent sees the discovery surface (capsule) and the obligations
  (packet). It cannot see hidden tests; those are proof's job.
- Obligations in the bench are **LLM-derived from the task intent** (the
  conservative floor; production is human+LLM 20/80 — see above). The packet
  is not authored with the answer; hidden tests are the only oracle.
- The question this arm answers: does adding the obligation layer raise
  verified task success versus capsule-only, and does it survive the
  can-hurt class (overhead > benefit)?

## Task contract (imported from proof)

Reuse `proof/bench`'s Task record as the fixture shape for the combined tasks:

```text
base        repo at buggy base revision
intent      verbatim task prompt
policy      .proof.yml content (obligation classes)
proposed    agent-style complete-looking change (tests pass) — for helps class
gold        correct change
hidden_tests  applied only at scoring
obligations   gold obligation IDs the packet must end satisfied
```

Manifest entry gains `proof_policy` + `gold_obligations` fields; the runner
materializes the packet next to the repo in scratch before the agent.

## Mileage — concurrency and subagents

- Bounded pool in the runner: run `n` (arm, task, rep) cells in parallel, each
  its own detached process group (so a hung cell is killed without wedging the
  shared opencode.db). Proof bench adopts the same pattern.
- Optional subagent orchestration: delegate each cell to a subagent that
  spawns opencode, captures the transcript, and returns a compressed result —
  main thread stays free, context stays small.
- Same driver guarantee: every cell runs the identical model, prompt, repo
  state, timeout, and accounting; concurrency only changes wall time.

## Acceptance gate for the combined arm

- Success non-inferior vs capsule-only and cold; hidden-test failures the
  capsule alone misses are caught by the proof arm (the helps signal);
- per-task results published, not just medians;
- the pair does not add more than ~10% wall/token overhead versus capsule-only
  on both-succeed tasks (can-hurt bound);
- both products remain independently runnable.

## Deliverables

```text
benchmark/manifest.yaml      + context+proof arm (enabled only when proof is present)
benchmark/tb21-fixture.yaml  unchanged (TB tasks run cold first)
benchmark/harbor.ts          cold-arm real-fixture runs on a docker host
benchmark/repo.ts            pin/clone (done)
src/hooks/                   capsule + (later) proof packet injection via the same hook path
proof/                       unchanged; combined bench calls `proof verify`
```
