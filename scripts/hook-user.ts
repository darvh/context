#!/usr/bin/env bun
import { runHook } from "../src/hooks/user";

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw || "{}") as Record<string, unknown>;
} catch {
  // Hook adapters fail open; malformed host input should not block the agent.
}

const task = String(input.prompt ?? input.message ?? input.user_prompt ?? "");
const cwd = String(input.cwd ?? input.workspace ?? process.cwd());
await runHook(task, cwd);
