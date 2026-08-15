#!/usr/bin/env bun
import { runAgentHook } from "../src/hooks/agent";

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw || "{}") as Record<string, unknown>;
} catch {
  // Hook adapters fail open; malformed host input should not block the agent.
}

const usage = input.usage as { input?: number; output?: number; total?: number } | undefined;
await runAgentHook({
  text: String(input.text ?? input.response ?? input.message ?? ""),
  usage: usage && {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    total: Number(usage.total ?? 0),
  },
  hook_event_name: typeof input.hook_event_name === "string" ? input.hook_event_name : undefined,
});
