import type { BuildResult } from "../src/build";
import { rankSymbols, explicitFilesFromTask } from "../src/query";
import { assemble, type Capsule } from "../src/assemble";

export interface MetricRun {
  arm: string;
  task: string;
  rep: number;
  status: "ok" | "timeout" | "error";
  success: boolean | null; // verify_cmd result, null when no verify
  editedGolden: boolean;
  firstRelevantMs: number | null;
  firstRelevantFile: string | null;
  firstEditMs: number | null;
  explorationBeforeFirstEdit: number;
  firstRelevantCalls: number;
  inputTokensBeforeFirstRelevant: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  wallMs: number;
  capsuleTokens: number;
  rawTokensInput: number;
  rawTokensOutput: number;
  rawCostUsd: number;
  failureCategory: string;
  verifyOutput: string;
}

export interface ParseCtx {
  goldenFiles: Set<string>;
  runStart: number; // epoch ms of run start
  usageMultiplier: number;
}

interface Step {
  ts: number;
  tokens?: { input: number; output: number; cache?: { read: number; write: number } };
  cost?: number;
}

export interface Transcript {
  toolUses: { ts: number; tool: string; input: string; output: string }[];
  texts: { ts: number; text: string }[];
  steps: Step[];
  firstTs: number;
}

export function parseTranscript(lines: string[]): Transcript {
  const t: Transcript = { toolUses: [], texts: [], steps: [], firstTs: 0 };
  for (const l of lines) {
    if (!l.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const ts = e.timestamp ?? 0;
    if (!t.firstTs) t.firstTs = ts;
    if (e.type === "tool_use" && e.part) {
      const state = e.part.state ?? {};
      t.toolUses.push({
        ts,
        tool: e.part.tool ?? "",
        input: JSON.stringify(state.input ?? {}),
        output: typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? ""),
      });
    } else if (e.type === "text" && e.part) {
      t.texts.push({ ts, text: e.part.text ?? "" });
    } else if (e.type === "step_finish" && e.part) {
      t.steps.push({
        ts,
        tokens: e.part.tokens,
        cost: e.part.cost,
      });
    }
  }
  return t;
}

function mentionsGolden(s: string, goldenFiles: Set<string>): string | null {
  for (const g of goldenFiles) {
    if (s.includes(g)) return g;
  }
  return null;
}

export function computeMetrics(
  t: Transcript,
  ctx: ParseCtx,
  extras: { capsuleTokens: number; wallMs: number; editedGolden: boolean; verifyStatus: boolean | null; verifyOutput: string },
): MetricRun {
  const { goldenFiles, runStart, usageMultiplier } = ctx;
  const m = usageMultiplier;

  let firstRelevantMs: number | null = null;
  let firstRelevantFile: string | null = null;
  let firstEditMs: number | null = null;
  let firstRelevantCalls = 0;
  let explorationBeforeFirstEdit = 0;
  let editedGolden = extras.editedGolden;

  // exploration + first relevant (tool outputs mentioning a golden file)
  for (const tu of t.toolUses) {
    if (firstEditMs === null && (tu.tool === "edit" || tu.tool === "write")) {
      firstEditMs = tu.ts - runStart;
      if (tu.input.includes("filePath") && mentionsGolden(tu.input, goldenFiles)) editedGolden = true;
      break; // exploration before first edit only counts pre-edit calls
    }
    explorationBeforeFirstEdit++;
    if (firstRelevantMs === null) {
      const hit = mentionsGolden(tu.output, goldenFiles) ?? mentionsGolden(tu.input, goldenFiles);
      if (hit) {
        firstRelevantMs = tu.ts - runStart;
        firstRelevantFile = hit;
        firstRelevantCalls = explorationBeforeFirstEdit;
      }
    }
  }
  // also agent text may name the golden file before any tool does
  if (firstRelevantMs === null) {
    for (const tx of t.texts) {
      const hit = mentionsGolden(tx.text, goldenFiles);
      if (hit) {
        firstRelevantMs = tx.ts - runStart;
        firstRelevantFile = hit;
        break;
      }
    }
  }

  let rawInput = 0;
  let rawOutput = 0;
  let cacheRead = 0;
  let rawCost = 0;
  let inputBeforeFirstRelevant = 0;
  for (const s of t.steps) {
    if (s.tokens) {
      rawInput += s.tokens.input ?? 0;
      rawOutput += s.tokens.output ?? 0;
      cacheRead += s.tokens.cache?.read ?? 0;
      if (firstRelevantMs !== null && s.ts - runStart <= firstRelevantMs) {
        inputBeforeFirstRelevant += s.tokens.input ?? 0;
      }
    }
    rawCost += s.cost ?? 0;
  }

  const totalTokens = (rawInput + rawOutput + cacheRead) * m;

  return {
    arm: "",
    task: "",
    rep: 0,
    status: "ok",
    success: extras.verifyStatus,
    editedGolden,
    firstRelevantMs,
    firstRelevantFile,
    firstEditMs,
    explorationBeforeFirstEdit,
    firstRelevantCalls,
    inputTokensBeforeFirstRelevant: inputBeforeFirstRelevant * m,
    inputTokens: rawInput * m,
    outputTokens: rawOutput * m,
    cacheReadTokens: cacheRead * m,
    totalTokens,
    costUsd: rawCost * m,
    wallMs: extras.wallMs,
    capsuleTokens: extras.capsuleTokens,
    rawTokensInput: rawInput,
    rawTokensOutput: rawOutput,
    rawCostUsd: rawCost,
    failureCategory: classify(rawInput === 0, firstRelevantMs, firstEditMs, extras.verifyStatus, editedGolden),
    verifyOutput: extras.verifyOutput.slice(0, 2000),
  };
}

export function classify(
  noSteps: boolean,
  firstRelevantMs: number | null,
  firstEditMs: number | null,
  verifyStatus: boolean | null,
  editedGolden: boolean,
): string {
  if (noSteps) return "environment";
  if (firstRelevantMs === null) return "navigation";
  if (firstEditMs === null) return "implementation-start";
  if (verifyStatus === false && editedGolden) return "implementation-or-tests";
  if (verifyStatus === false) return "implementation";
  return "success";
}

/** Build the Context capsule block for arm B, prepended to the prompt. */
export async function capsuleBlock(b: BuildResult, task: string): Promise<{ block: string; tokens: number }> {
  const changed = new Set<string>();
  const explicitFiles = explicitFilesFromTask(task, b.files);
  const hits = rankSymbols({ task, graph: b.graph, changed, explicitFiles });
  const capsule: Capsule = assemble({ task, build: b, hits, budgetTokens: 1200 });
  const lines: string[] = [];
  lines.push(`[context capsule — deterministic navigation map; not evidence]`);
  lines.push(`working_tree: ${capsule.workingTree}`);
  if (capsule.files.length) {
    lines.push(`paths:`);
    for (const f of capsule.files) lines.push(`- ${f}`);
  }
  for (const h of capsule.hits) {
    lines.push(`- ${h.kind} ${h.name} ${h.file}:${h.line} (${h.conf}) sig: ${h.sig}`);
  }
  if (capsule.truncated) lines.push(`(truncated)`);
  lines.push(`prefer these locations; expand with \`context expand <handle>\` if needed`);
  const block = lines.join("\n");
  return { block, tokens: capsule.tokensUsed };
}

export const fmt = (n: number | null) => (n === null ? "" : String(n));
