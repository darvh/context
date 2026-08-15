#!/usr/bin/env bun
// SessionStart adapter: injects a compact "context is available" trigger so
// every session knows repository discovery exists, even when skills are not
// auto-loaded. Deliberately tiny (~40 tokens) — the skill file is the full
// command reference. Plain-text stdout works for both Claude Code and Codex
// SessionStart hooks (added as extra developer context). Fail open.
const REMINDER =
  "Repository discovery is available via `context observe \"<task>\"` — run it once before non-trivial multi-file work. " +
  "It returns the task-relevant directories, files, and symbols with source spans. " +
  "Drill down with `context map <dir>`, `context follow <symbol> [edge|symbol2]`, `context impact <symbol>`, `context expand <handle>`. " +
  "Navigation only — read the source for evidence. See the context skill for the full reference.";

process.stdout.write(REMINDER + "\n");
