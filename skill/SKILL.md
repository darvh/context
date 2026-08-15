---
name: context
description: Deterministic repository discovery for coding agents. Use before non-trivial repository work to find relevant files and symbols.
---

# Context skill

One `context observe` call replaces repetitive searching. Output is navigation
only — source, Git, and tests are authoritative.

## When to call (once, before exploration)

| Task | Call? |
|---|---|
| multi-file bug, refactor, or feature | `observe` first |
| unfamiliar codebase or area | `observe` first |
| "where is / how does X work" | `observe` |
| one-file edit, obvious fix | skip |
| same task after an edit | skip (index refreshes) |

## How to use the capsule

1. `context observe "<task>"` — returns: `directories` (DirMap), `paths`,
   hits with source ranges, and a `confidence` label.
2. Start from the capsule. Do not re-search what it already shows.
3. Drill down only where needed:

   | Command | When |
   |---|---|
   | `context map <dir>` | need a file-level map of one directory |
   | `context follow <symbol> <edge>` | need one-edge-kind trails (call, import, test, ...) |
   | `context follow <symbol> <symbol2>` | need how two symbols connect |
   | `context impact <symbol>` | need callers/callees, tests, documented_by, diff |
   | `context expand <handle\|file:line>` | need the exact source span |

4. Read `confidence`: `strong` = trust and go; `conflicted` = several
   competing neighborhoods, pick by reading; `weak`/`empty` = fall back to
   grep/rg, context could not resolve it.

## Rules

- Never treat output as evidence — read the source it points at.
- Never rerun `observe` for the same task after edits; the index refreshes on
  demand.
- `context impact --diff` lists changed files and their dependents.
- `--json` returns the same capsule for machine use; all results are
  deterministic and model-free.
