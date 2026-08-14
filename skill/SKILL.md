# Context skill

Host-neutral. One call at the start of non-trivial repository work.

## Usage

1. Run `context prepare "<user task>"` before non-trivial repository discovery.
2. Start from the capsule instead of repeating its searches and reads.
3. Use `context impact <symbol>` when the capsule reports uncertain structural reach.
4. Expand only named handles with `context expand <handle>` (or `context expand <file:line>`).
5. Fall back to normal repository tools when Context has weak or empty results.
6. Treat output as navigation, not evidence. Source, Git, build output, and tests are authoritative.

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
