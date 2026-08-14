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
context init [--targets all|opencode,claude-code,codex,cursor,copilot,antigravity,pi]
             [--project] [--force] [--dry-run] [--hooks]
```

## Install

### macOS, Linux, or WSL

```bash
curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
```

Useful flags: `--local`, `--targets <agents>`, `--force`, and `--dry-run`.
Add `--hooks` to wire the Claude Code adapters. The installer requires Bun.

### From a checkout

```bash
bun run src/cli.ts init --project
```

`context init` installs the host-neutral skill into each agent's skill
directory (same matrix as proof: opencode, claude-code, codex, cursor,
copilot, antigravity, pi), user or project scope. Idempotent: identical copies are
`up-to-date`, conflicts are skipped unless `--force`, absent home-scope agent
dirs are reported and never created silently. `--hooks` additionally wires the
UserPromptSubmit + agent-response hook adapters (claude-code settings today) —
explicit opt-in, never silent.

## Development

```text
bun install
bun run context prepare "where is session persistence handled?" --root <repo>
bun test
bun run spike          # feasibility benchmark -> spike/results.json
bun run build          # standalone binary -> ./dist/context
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

## Hooks (host adapters, both fail open)

- `scripts/hook-user.ts` — UserPromptSubmit: injects one compact capsule per
  (task, working-tree) pair; never rewrites commands or mutates the repo.
- `scripts/hook-agent.ts` — agent-response (Claude Code `Stop`): reads the
  projected savings the user hook stored and emits a Graft-style
  `~X tokens saved (Y%, net ~Z after capsule)` line. **User-visible only** —
  it is telemetry, never injected back into the model context.

Savings projection (`src/savings.ts`) estimates the input tokens the capsule
replaces (its pointed-at source spans) minus capsule tokens; `estimated`, per
the plan's token accounting. Benchmark-only proof lives in `benchmark/`.

Current benchmark results are sample-fixture only (spike fixtures), not a
product claim; the real fixture (SWE-bench / Terminal-Bench 2.1 via harbor) is
pending.

See `skill/SKILL.md` for the host-neutral agent skill and `spike/README.md`
for the feasibility spike.
