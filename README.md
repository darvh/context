# Context

Deterministic discovery compiler for coding agents. Turns a task plus the
current working tree into a small, source-backed context capsule — no model,
no embeddings, no repo-local state.

Per `meta/cross-product/context.md` and `context-implementation-plan.md`:
Bun/TypeScript MVP 1, Tree-sitter for Go / TypeScript / JavaScript / Python,
plain external content-addressed cache, deterministic lexical + graph ranking.

## Commands

```text
context prepare "<task>" [--budget N] [--json] [--root DIR]
context expand <handle|file:line>
context impact <symbol|--diff> [--json]
```

## Development

```text
bun install
bun run src/cli.ts prepare "where is session persistence handled?" --root <repo>
bun test
bun run spike          # feasibility benchmark -> spike/results.json
bun run build          # standalone binary -> ./context-bin
```

Cache lives in `$XDG_CACHE_HOME/context` (default `~/.cache/context`), keyed
by canonical repo path. Incremental: only changed files reparse. Working-tree
edits (staged, unstaged, untracked) are visible on the next call.

## Invariants

- No model calls, annotations, embeddings, or API keys.
- No repository-local generated files; never writes into the project.
- Every assertion points to source and labels resolution quality.
- Deterministic output for a fixed tree + task.
- Emits `context:telemetry <json>` on stderr; all token counts are `estimated`.

See `skill/SKILL.md` for the host-neutral agent skill and `spike/README.md`
for the feasibility spike.
