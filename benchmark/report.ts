import { promises as fs } from "node:fs";
import path from "node:path";
import type { MetricRun } from "./metrics";

const CSV_HEADER = [
  "arm", "task", "rep", "status", "success", "edited_golden",
  "first_relevant_ms", "first_relevant_file", "first_edit_ms",
  "exploration_before_first_edit", "first_relevant_calls",
  "input_tokens", "output_tokens", "cache_tokens", "total_tokens",
  "cost_usd", "wall_ms", "capsule_tokens", "failure_category",
];

function csvRow(r: MetricRun): string[] {
  return [
    r.arm, r.task, String(r.rep), r.status, r.success === null ? "" : String(r.success), String(r.editedGolden),
    r.firstRelevantMs === null ? "" : String(r.firstRelevantMs), r.firstRelevantFile ?? "", r.firstEditMs === null ? "" : String(r.firstEditMs),
    String(r.explorationBeforeFirstEdit), String(r.firstRelevantCalls),
    String(r.inputTokens), String(r.outputTokens), String(r.cacheReadTokens), String(r.totalTokens),
    r.costUsd.toFixed(6), String(r.wallMs), String(r.capsuleTokens), r.failureCategory,
  ];
}

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export async function writeReport(runs: MetricRun[], outDir: string, manifest: { model: { id: string; usage_multiplier: number } }): Promise<void> {
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
  lines.push(`Model: \`${manifest.model.id}\` — usage multiplier ${manifest.model.usage_multiplier}x (deepseek-v4-flash billing).`);
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
  metric("input tokens before first relevant (median)", (rs) => "-"); // not captured per-run
  metric("total input tokens (median)", (rs) => med(rs.map((r) => r.inputTokens)) ?? "-");
  metric("total tokens (median)", (rs) => med(rs.map((r) => r.totalTokens)) ?? "-");
  metric("cost USD (sum)", (rs) => rs.reduce((a, r) => a + r.costUsd, 0).toFixed(4));
  lines.push("");
  lines.push(`Net savings (per arm vs cold, medians): input_tokens_savings_pct, net after capsule+tools — see failure-analysis.md per task.`);
  lines.push("");
  lines.push(`Run details in \`results.csv\`; transcripts in \`raw/\`.`);
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
