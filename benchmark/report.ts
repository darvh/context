import { promises as fs } from "node:fs";
import path from "node:path";
import type { MetricRun } from "./metrics";

const CSV_HEADER = [
  "arm", "task", "rep", "status", "success", "edited_golden",
  "first_relevant_ms", "first_relevant_file", "first_edit_ms",
  "exploration_before_first_edit", "first_relevant_calls", "input_before_first_relevant",
  "input_tokens", "output_tokens", "cache_tokens", "input_miss_tokens", "cache_hit_pct",
  "total_tokens", "cost_usd",
  "wall_ms", "capsule_tokens", "failure_category",
];

function csvRow(r: MetricRun): string[] {
  return [
    r.arm, r.task, String(r.rep), r.status, r.success === null ? "" : String(r.success), String(r.editedGolden),
    r.firstRelevantMs === null ? "" : String(r.firstRelevantMs), r.firstRelevantFile ?? "", r.firstEditMs === null ? "" : String(r.firstEditMs),
    String(r.explorationBeforeFirstEdit), String(r.firstRelevantCalls), String(r.inputTokensBeforeFirstRelevant),
    String(r.inputTokens), String(r.outputTokens), String(r.cacheReadTokens), String(r.inputMissTokens), r.cacheHitPct.toFixed(1),
    String(r.totalTokens), r.costUsd.toFixed(6),
    String(r.wallMs), String(r.capsuleTokens), r.failureCategory,
  ];
}

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function writeReport(runs: MetricRun[], outDir: string, manifest: { model: { id: string; usage_multiplier: number; pricing?: { input_miss_per_1m?: number; input_hit_per_1m?: number; output_per_1m?: number } } }): Promise<void> {
  // results.csv
  const rows = [CSV_HEADER.join(",")];
  for (const r of runs) rows.push(csvRow(r).join(","));
  await fs.writeFile(path.join(outDir, "results.csv"), rows.join("\n") + "\n");

  // summary.md
  const byArm = new Map<string, MetricRun[]>();
  for (const r of runs) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
  const lines: string[] = [];
  lines.push(`# Context benchmark summary`);
  lines.push("");
  lines.push(`Model: \`${manifest.model.id}\` — usage multiplier ${manifest.model.usage_multiplier}x on reported tokens.`);
  const p = manifest.model.pricing;
  lines.push(
    `Cost = true API pricing: input cache-miss $${p?.input_miss_per_1m ?? 0}/1M, cache-hit $${p?.input_hit_per_1m ?? 0}/1M (98% off), ` +
    `output $${p?.output_per_1m ?? 0}/1M, no cache-write fee. Computed from provider raw tokens.`,
  );
  lines.push(`Token and cost figures below are already multiplied. Token totals are provider-reported via \`step_finish\`.`);
  lines.push("");
  lines.push(`| metric | ` + [...byArm.keys()].map((a) => a).join(" | ") + ` |`);
  lines.push(`| --- | ` + [...byArm.keys()].map(() => "---").join(" | ") + ` |`);
  const metric = (name: string, fn: (rs: MetricRun[]) => (string | number)) =>
    lines.push(`| ${name} | ` + [...byArm.entries()].map(([a, rs]) => String(fn(rs))).join(" | ") + ` |`);
  metric("verified success rate", (rs) => (rs.filter((r) => r.success).length / Math.max(1, rs.filter((r) => r.success !== null).length)).toFixed(2));
  metric("first-relevant recall", (rs) => (rs.filter((r) => r.firstRelevantMs !== null).length / Math.max(1, rs.length)).toFixed(2));
  metric("time to first relevant (ms, median)", (rs) => med(rs.map((r) => r.firstRelevantMs ?? 0)) ?? "-");
  metric("time to first edit (ms, median)", (rs) => med(rs.map((r) => r.firstEditMs ?? 0)) ?? "-");
  metric("exploration calls before first edit (median)", (rs) => med(rs.map((r) => r.explorationBeforeFirstEdit)) ?? "-");
  metric("input tokens before first relevant (median)", (rs) => med(rs.map((r) => r.inputTokensBeforeFirstRelevant)) ?? "-");
  metric("total input tokens (median)", (rs) => med(rs.map((r) => r.inputTokens)) ?? "-");
  metric("cache hit % (median)", (rs) => med(rs.map((r) => r.cacheHitPct))?.toFixed(1) ?? "-");
  metric("total tokens (median)", (rs) => med(rs.map((r) => r.totalTokens)) ?? "-");
  metric("cost USD (sum)", (rs) => rs.reduce((a, r) => a + r.costUsd, 0).toFixed(4));
  lines.push("");
  lines.push("## Net savings vs cold (per task, median)");
  lines.push("");
  lines.push("```text");
  lines.push("gross_savings = cold_input - assisted_input");
  lines.push("net_savings   = gross_savings - capsule_tokens - added_tool_output");
  lines.push("net_pct       = net_savings / cold_input");
  lines.push("```");
  lines.push("");
  const tasks = [...new Set(runs.map((r) => r.task))];
  for (const task of tasks) {
    const cold = runs.filter((r) => r.arm === "cold" && r.task === task);
    const ctx = runs.filter((r) => r.arm === "context" && r.task === task);
    const coldIn = med(cold.map((r) => r.inputTokens));
    const ctxIn = med(ctx.map((r) => r.inputTokens));
    const ctxCap = med(ctx.map((r) => r.capsuleTokens)) ?? 0;
    lines.push(`### ${task}`);
    if (coldIn === null || ctxIn === null) {
      lines.push("missing cold or context runs — can't compute savings.");
    } else {
      const gross = coldIn - ctxIn;
      const net = gross - ctxCap;
      lines.push(`- gross_input_savings: ${Math.round(gross)} (${((gross / coldIn) * 100).toFixed(1)}%)`);
      lines.push(`- net_savings (after capsule): ${Math.round(net)} (${((net / coldIn) * 100).toFixed(1)}%)`);
      lines.push(`- exploration calls saved: ${(med(cold.map((r) => r.explorationBeforeFirstEdit)) ?? 0) - (med(ctx.map((r) => r.explorationBeforeFirstEdit)) ?? 0)}`);
      lines.push(`- success preserved: ${ctx.some((r) => r.success === false) ? "no" : "yes"}`);
    }
    lines.push("");
  }
  lines.push(`Run details in \`results.csv\`; transcripts in \`raw/\`.`);
  lines.push(`Caveat: single-rep cells are diagnostic samples, not claims — the plan requires >=2 reps per arm.`);
  await fs.writeFile(path.join(outDir, "summary.md"), lines.join("\n") + "\n");

  // failure-analysis.md
  const fa: string[] = [];
  fa.push(`# Failure analysis`);
  fa.push("");
  const fails = runs.filter((r) => r.success !== true || r.firstRelevantMs === null);
  fa.push(`Runs with a miss: ${fails.length}/${runs.length}`);
  fa.push("");
  for (const r of fails) {
    fa.push(`## ${r.arm}/${r.task} r${r.rep}`);
    fa.push(`- status: ${r.status}, success: ${r.success === null ? "n/a" : r.success}, category: ${r.failureCategory}`);
    fa.push(`- first relevant: ${r.firstRelevantMs === null ? "MISS" : `${r.firstRelevantMs}ms @ ${r.firstRelevantFile}`}`);
    fa.push(`- first edit: ${r.firstEditMs === null ? "MISS" : `${r.firstEditMs}ms`}, exploration before edit: ${r.explorationBeforeFirstEdit}`);
    fa.push(`- tokens: ${r.inputTokens} in / ${r.outputTokens} out / ${r.cacheReadTokens} cache, cost $${r.costUsd.toFixed(6)}`);
    if (r.verifyOutput.trim()) fa.push(`- verify: ${r.verifyOutput.replace(/\n/g, " | ").slice(0, 400)}`);
    fa.push("");
  }
  fa.push(`Category taxonomy: environment / navigation / implementation-start / implementation-or-tests / implementation / success.`);
  fa.push(`Every miss must be classified before a capability is added (see context.md Phase 4).`);
  await fs.writeFile(path.join(outDir, "failure-analysis.md"), fa.join("\n") + "\n");
}
