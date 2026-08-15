import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols, explicitFilesFromTask, queryConfidence, appendSemanticHits } from "../src/query";
import { buildBm25Index } from "../src/bm25";
import { semanticSearch, type SemanticTune } from "../src/semantic";
import { repoKey } from "../src/cache";
import { buildTaskDirs, loadAllTasks, measureRecall, type Task } from "./eval-shared";

/**
 * Semantic-lane hypothesis sweep. Varies one indexing/fusion knob at a time
 * against the shipped config and reports per-task deltas (file recall + MRR)
 * on the same pinned corpus. The lane is force-applied to every task so the
 * lane itself is measured; the confidence gate decides activation in the
 * product (weak/empty only), reported separately per task.
 *
 *   bun run scripts/experiment-semantic.ts [--real]
 */

const args = process.argv.slice(2);
const useReal = args.includes("--real") || args.includes("real");

const MODES: { name: string; tune: SemanticTune }[] = [
  { name: "base", tune: {} },
  { name: "snippet40", tune: { snippetLines: 40 } },
  { name: "docsec", tune: { docMode: "sections" } },
  { name: "dirfull", tune: { dirFull: true } },
  { name: "minsim15", tune: { minSim: 0.15 } },
  { name: "minsim30", tune: { minSim: 0.3 } },
];

const allTasks = await loadAllTasks(useReal);
const taskDirs = await buildTaskDirs(allTasks, useReal);


const rows: Record<string, Record<string, { gate: string; recallFiles: number; mrr: number }>> = {};

for (const t of allTasks) {
  const b = await build(taskDirs.get(t.repo)!);
  const idx = buildBm25Index(b.graph, b.docs);
  const base = rankSymbols({
    task: t.query,
    graph: b.graph,
    changed: new Set(t.changed),
    explicitFiles: explicitFilesFromTask(t.query, b.files),
    bm25: idx,
    docs: b.docs,
  });
  const gate = queryConfidence(base);
  rows[t.id] = {};
  if (gate === "strong") {
    // production never consults the lane on strong tasks; record the base
    // result and skip the sweep (saves most of the embedding cost)
    for (const mode of MODES) rows[t.id][mode.name] = { gate, recallFiles: 0, mrr: 0 };
    rows[t.id].base = { gate, recallFiles: measureRecall(base, t).recallFiles, mrr: measureRecall(base, t).mrr };
    continue;
  }
  for (const mode of MODES) {
    // force the lane on every weak task to measure the lane itself
    const sem = await semanticSearch(b.root, b.graph, b.docs, t.query, { repoKey: repoKey(b.root), tune: mode.tune });
    const fused = sem?.symbols.length ? appendSemanticHits(base, sem.symbols, b.graph, b.docs, t.query) : base;
    const m = measureRecall(fused, t);
    rows[t.id][mode.name] = { gate, recallFiles: m.recallFiles, mrr: m.mrr };
  }
  if (!Object.values(rows[t.id]).some((r) => r.recallFiles > 0)) {
    // expected file never surfaced in any mode: still report the row
  }
}

const names = MODES.map((m) => m.name);
const baseModes = ["base", "snippet40", "docsec", "dirfull", "minsim15", "minsim30"];
const sums = Object.fromEntries(baseModes.map((n) => [n, { recallFiles: 0, mrr: 0, count: 0 }]));
let n = 0;
let weak = 0;
console.log(`\nper-task (file% / mrr) — semantic force-applied on weak tasks, skipped on strong:`);
for (const [id, m] of Object.entries(rows)) {
  n++;
  if (m.base.gate !== "strong") weak++;
  console.log(
    `  ${id.padEnd(14)} ` +
      names.map((name) => `${name.slice(0, 7).padEnd(8)} ${m[name].gate === "strong" ? "skipped" : `${(m[name].recallFiles * 100).toFixed(0).padStart(3)}%/${m[name].mrr.toFixed(2).padStart(5)}`}`).join(" "),
  );
  for (const name of names) {
    if (m[name].gate === "strong") continue; // not run
    sums[name].recallFiles += m[name].recallFiles;
    sums[name].mrr += m[name].mrr;
    sums[name].count++;
  }
}
console.log(`\navg over weak tasks (${weak}/${n} weak or empty; lane activates only there in production):`);
for (const name of names) {
  const s = sums[name];
  if (!s.count) {
    console.log(`  ${name.padEnd(9)} (no weak tasks)`);
    continue;
  }
  console.log(`  ${name.padEnd(9)} files ${((s.recallFiles / s.count) * 100).toFixed(1)}%  mrr ${(s.mrr / s.count).toFixed(3)}  (n=${s.count})`);
}

await fs.writeFile(path.join(import.meta.dir, "..", "var", "semantic-experiment.json"), JSON.stringify({ real: useReal, rows, sums }, null, 2));
console.log("\nraw -> var/semantic-experiment.json");
