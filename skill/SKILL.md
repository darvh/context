---
name: context
description: Deterministic repository discovery for coding agents. Use before non-trivial repository work to find relevant files and symbols.
---

# Context skill

Host-neutral. One call at the start of non-trivial repository work.

## Usage

1. Run `context observe "<user task>"` (alias: `prepare`) before non-trivial repository discovery.
2. Start from the capsule instead of repeating its searches and reads. The capsule shows the top directories (DirMap), relevant files, and hits with source ranges.
3. Use `context map <directory>` when a neighborhood needs a local file-level map.
4. Use `context follow <symbol> <edge>` when a graph trail matters more than a score.
5. Use `context impact <symbol>` for callers, tests, and the working-tree diff.
6. Expand only named handles with `context expand <handle>` (or `context expand <file:line>`).
7. Fall back to normal repository tools when Context has weak or empty results.
8. Treat output as navigation, not evidence. Source, Git, build output, and tests are authoritative.

## When not to use

- Obvious one-file work: skip `prepare`.
- Do not rerun `prepare` after every edit; the index refreshes on demand.
- Do not claim token savings without a measured baseline.

## Notes

- All results are deterministic and model-free.
- Working-tree edits (staged, unstaged, untracked) are visible on the next call.
- `--json` returns the same capsule for machine use.
- `context impact --diff` lists changed files and dependents.
- Token-savings projections (`scripts/hook-agent.ts`) are user-visible telemetry,
  never injected into the model context.
