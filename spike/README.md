# Context feasibility spike

Per `meta/cross-product/spike.md`: can Bun/TypeScript deliver Context MVP 1
(reliability, distribution), or should the structural core be Rust?

Question is runtime + packaging feasibility, not product quality. The spike
reused the real pipeline (`../src`) through thin wrappers; the spike code is
disposable and has been removed — the evaluation area (`eval/`, `scripts/eval.ts`)
owns the fixtures and measurements now.

## Runtime decision (this host: macOS arm64, Bun 1.4.0)

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

`bun build --compile` produces a ~60 MB binary, but every compiled binary on
this host is SIGKILL'd (exit 137) at exec — even a trivial `console.log`
probe. This is an environment/sandbox limitation, not a Context defect.
Standalone packaging needs a host without the sandbox or a stable Bun
release. Grammar assets are resolved beside the binary (`spike/grammars/`,
overridable via `CONTEXT_GRAMMAR_DIR`), so no `node_modules` is required at
runtime.

Bun path: recommended to keep for MVP 1 pending a real-host binary check.

## Fixtures

`fixtures/{go,typescript,python,multilang}/` — small session-store apps per
language with tests, routes, entry points, cross-file references, and the
unrelated `cmd/migrate/` dirty-tree file. Shared with `eval/`; regenerate or
extend them there.
