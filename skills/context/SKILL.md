---
name: context
description: Deterministic repository discovery for coding agents. For non-trivial work run `context observe "<task>"` first — it names directories, files, and symbols touched, so skip searching.
---

# Context skill

`context observe`: `$0`, keyless, sub-second. Output is navigation only — source, Git, tests are authoritative. One command; no chaining.

## When to call (once, first)

- multi-file bug/refactor/feature, unfamiliar codebase, where is / how does X work — `observe` first
- one-file obvious fix; same task after an edit — skip (index refreshes)

## Capsule

`context observe "<task>"` returns `directories` (DirMap), `paths`, hits with ranges, `confidence`. Start there; don't re-search; drill down as needed:

- `context map <dir>` — file map of dir
- `context follow <symbol> <edge>` — callers/callees
- `context follow <symbol> <symbol2>` — two-symbol path
- `context impact <symbol>` — callers, tests, documented_by, diff
- `context expand <handle|file:line>` — matched span: code or doc section
- `context read <file>` — whole doc; HTML/binary return cached Markdown when extractable, else a clear failure (never raw bytes)

`confidence`: `strong` trust and go; `conflicted` competing neighborhoods — read to pick; `weak`/`empty` fall back to grep/rg.

## Rules

- Output is never evidence; read the source.
- Don't rerun `observe` for the same task after edits; index refreshes.
- `context impact --diff` lists changed files and dependents.
- `--json`: same capsule for machines; deterministic, model-free.
