# Context feasibility spike

Per `meta/cross-product/spike.md`: can Bun/TypeScript deliver Context MVP 1
(reliability, distribution), or should the structural core be Rust?

Question is runtime + packaging feasibility, not product quality. The spike
reuses the real pipeline (`../src`) through thin wrappers; schemas seed MVP 1,
the spike code is disposable.

## Scope checks

1. locate a repository root;
2. walk files respecting ignore rules;
3. parse one Go, TypeScript, and Python fixture with Tree-sitter;
4. emit symbols, signatures, and source spans;
5. write and reload a content-hash cache;
6. accept a query and return a deterministic ranked result;
7. run through the UserPromptSubmit adapter (`src/hook.ts`);
8. compile/package as a standalone Bun executable (grammars beside the binary).

## Fixtures

`fixtures/{go,typescript,python}/` — a small session-store app in each
language with tests, routes, entry points, and cross-file references.

## Run

```text
bun run spike            # runs bench.ts -> spike/results.json
bun run build            # compile standalone binary -> ./dist/context
```

## Budgets (from spike.md, provisional)

```text
warm query:       <150 ms
incremental scan: <500 ms
cold fixture:     <2 s
hook timeout:     ~1 s, fail open
```

Go/no-go: stay on Bun if platforms run the compiled binary, grammars package
reliably, warm/incremental latency holds, cache is correct, install friction is
acceptable, and the benchmark shows discovery savings. Otherwise promote the
structural core to Rust.

## Findings (this host: macOS arm64, Bun 1.4.0)

`spike/results.json` holds the measured values. Summary:

| check | result |
| --- | --- |
| grammar loading | WASM grammars ship in the npm packages; load fine under Bun |
| cold parse (per fixture) | 18–30 ms |
| warm query | ~14 ms (budget <150 ms) |
| incremental (1-file edit) | 1 parsed, 3 reused, <1 ms refresh (budget <500 ms) |
| cache reload | 0 reparsed (hit), versioned `context-cache-v2` |
| deterministic | two identical queries produce identical output |
| hook (UserPromptSubmit) | ~80 ms, fail-open, dedupes per task+tree |
| startup (`bun run`) | ~20 ms |
| standalone binary | **blocked by host sandbox** — see below |

### Standalone binary caveat

`bun build --compile` produces a 61 MB binary, but every compiled binary on
this host is SIGKILL'd (exit 137) at exec — even a trivial `console.log`
probe. This is an environment/sandbox limitation, not a Context defect. The
bench harness detects this and records it as a failure; standalone packaging
needs a host without the sandbox or a stable Bun release. Grammar assets are
resolved beside the binary (`spike/grammars/`, overridable via
`CONTEXT_GRAMMAR_DIR`), so no `node_modules` is required at runtime.

Bun path: recommended to keep for MVP 1 pending a real-host binary check.
