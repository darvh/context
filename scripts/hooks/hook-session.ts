#!/usr/bin/env bun
import { sessionOrientation } from "../../src/hooks/session";

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw || "{}") as Record<string, unknown>;
} catch {
  // Hook adapters fail open; malformed host input should not block the agent.
}
const cwd = String(input.cwd ?? input.workspace ?? process.cwd());
// JSON hook shape: additionalContext injects into the session on both Claude
// Code and Codex SessionStart (both accept hookSpecificOutput JSON)
const text = await sessionOrientation(cwd);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) + "\n");
