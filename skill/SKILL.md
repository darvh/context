---
name: context
description: Deterministic repository discovery for coding agents. For non-trivial work — bug hunts, feature builds, unfamiliar code — run `context observe "<task>"` first; it names the directories, files, and symbols the task touches, so you can skip the searching.
---

# Context skill

One `context observe` call replaces repetitive searching. It is `$0` (the installed command), needs no API key, and returns in well under a second. Output is navigation only — source, Git, and tests are authoritative.

**Choose the single command that fits, run it, and act on the result; resist chaining tools. Most tasks need exactly one call.**

## When to call (once, before exploration)

| Task | Call? |
|---|---|
| multi-file bug, refactor, or feature | `observe` first |
| unfamiliar codebase or area | `observe` first |
| "where is / how does X work" | `observe` |
| one-file edit, obvious fix | skip |
| same task after an edit | skip (index refreshes) |

## How to use the capsule

1. `context observe "<task>"` — returns: `directories` (DirMap), `paths`, hits with source ranges, and a `confidence` label.
2. Start from the capsule. Do not re-search what it already shows.
3. Drill down only where needed:

   | Command | When |
   |---|---|
   | `context map <dir>` | need a file-level map of one directory |
   | `context follow <symbol> <edge>` | need callers/callees trails |
   | `context follow <symbol> <symbol2>` | need how two symbols connect |
   | `context impact <symbol>` | need callers, tests, documented_by, diff |
   | `context expand <handle\|file:line>` | need the source span that matched — code or one doc section |
   | `context read <file>` | need the whole document, not just the matched section (binary PDF/Office — cannot be read directly) |

4. Read `confidence`: `strong` = trust and go; `conflicted` = several competing neighborhoods, pick by reading; `weak`/`empty` = fall back to grep/rg, context could not resolve it.

## Rules

- Never treat output as evidence — read the source it points at.
- Never rerun `observe` for the same task after edits; the index refreshes on demand.
- `context impact --diff` lists changed files and their dependents.
- `--json` returns the same capsule for machine use; all results are deterministic and model-free.
