---
name: context
description: Deterministic repository discovery for coding agents. For ANY non-trivial task — understanding how something works, finding where code lives, tracing callers, or scoping an edit — get your context from `context observe` BEFORE grepping or reading source files.
---

# Context skill

One `context observe` call replaces repetitive searching. It is `$0` (the
installed command), needs no API key, and returns in well under a second.
Output is navigation only — source, Git, and tests are authoritative.

**Pick the one command that fits, run it, act on the answer; don't chain
tools hoping for more. Most tasks need one call.**

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
   | `context follow <symbol> <edge>` | need callers/callees trails |
   | `context follow <symbol> <symbol2>` | need how two symbols connect |
   | `context impact <symbol>` | need callers, tests, documented_by, diff |
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
