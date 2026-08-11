#!/usr/bin/env bun
import { runAgentHook } from "../src/hook-agent";

// Claude Code Stop hook: the last assistant message is available on stdin as
// `{session_id, transcript_path, message: {content}}`. Fall back to argv.
let text = "";
let usage: { input: number; output: number; total: number } | undefined;
try {
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    const ev = JSON.parse(raw);
    text = typeof ev?.message?.content === "string" ? ev.message.content : JSON.stringify(ev);
    if (ev?.hookSpecificOutput?.usage) usage = ev.hookSpecificOutput.usage;
  }
} catch {}
if (!text) text = process.argv.slice(2).join(" ");

await runAgentHook({ text, usage });
