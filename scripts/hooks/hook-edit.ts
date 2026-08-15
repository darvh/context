#!/usr/bin/env bun
import { runEditHook } from "../../src/hooks/edit";

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw || "{}") as Record<string, unknown>;
} catch {
  // Hook adapters fail open; malformed host input should not block the agent.
}
await runEditHook(input as { tool_input?: { file_path?: string; command?: string }; hook_event_name?: string; cwd?: string });
