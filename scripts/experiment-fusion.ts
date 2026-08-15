import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols, explicitFilesFromTask, meaningfulTerms, terms } from "../src/query";
import { buildBm25Index, bm25Search } from "../src/bm25";
import { buildTaskDirs, loadAllTasks, measureRecall, type Task } from "./eval-shared";
import type { RankedHit } from "../src/query";

/**
 * Fusion experiment: does multi-query + full RRF re-rank beat the current
 * authoritative-append fusion? Measures file recall@k and MRR per task across
 * modes:
 *
 *   current  graph+lexical, BM25 appends below, docs gated by coverage
 *            (faithful replication of the shipping hybrid tail)
 *   rrf1     RRF(graph list, bm25 list) — single query
 *   rrf3     RRF(graph list, bm25 v1/v2/v3) — three deterministic variants
 *   rrf3pin  rrf3 + authoritative hits pinned at rank 0 of the graph list
 *
 * Deterministic, same corpus and budget as eval. bun run scripts/experiment-fusion.ts [--real]
 */

const args = process.argv.slice(2);
const useReal = args.includes("--real") || args.includes("real");
const RRF_K = 60;

const allTasks = await loadAllTasks(useReal);
const taskDirs = await buildTaskDirs(allTasks, useReal);

interface Scored {
  id: string;
  file: string;
  name: string;
  reason: string[];
  score: number;
}

const AUTHORITATIVE = ["exact-name", "explicit-file", "recent-change"];

function graphList(b: Awaited<ReturnType<typeof build>>, t: Task): RankedHit[] {
  return rankSymbols({
    task: t.query,
    graph: b.graph,
    changed: new Set(t.changed),
    explicitFiles: explicitFilesFromTask(t.query, b.files),
    bm25: undefined,
    docs: [],
  });
}

function toScored(h: RankedHit): Scored {
  return { id: h.symbol.id, file: h.symbol.file, name: h.symbol.name, reason: h.reason, score: h.score };
}

/** The shipping hybrid tail: graph hits, then bm25 symbols, then gated docs. */
function currentFusion(graph: RankedHit[], b: Awaited<ReturnType<typeof build>>, idx: ReturnType<typeof buildBm25Index>, t: Task): Scored[] {
  const out = graph.map(toScored);
  const seen = new Set(out.map((m) => m.id));
  const tset = new Set(meaningfulTerms(t.query));
  let maxCodeMatched = 0;
  for (const s of b.graph.symbols) {
    if (s.kind === "import") continue;
    const st = new Set([...terms(s.name), ...terms(s.sig), ...terms(s.doc)]);
    let m = 0;
    for (const term of tset) if (st.has(term)) m++;
    if (m > maxCodeMatched) maxCodeMatched = m;
  }
  const pinned = out.some((m) => m.reason.some((r) => AUTHORITATIVE.includes(r)));
  for (const hit of bm25Search(idx, t.query, 20)) {
    if (hit.kind === "doc") {
      const d = b.docs[hit.doc ?? -1];
      if (!d) continue;
      const id = `doc::${d.file}`;
      if (seen.has(id)) continue;
      const coverage = meaningfulTerms(d.text).filter((x) => tset.has(x)).length;
      if (pinned || coverage <= maxCodeMatched) continue; // gated: no better than code
      out.push({ id, file: d.file, name: d.file.split("/").pop() ?? d.file, reason: ["doc-match"], score: 5 });
      seen.add(id);
    } else {
      const s = b.graph.symbols[hit.rowid];
      if (!s || s.kind === "import" || seen.has(s.id)) continue;
      out.push({ id: s.id, file: s.file, name: s.name, reason: ["bm25"], score: 0 });
      seen.add(s.id);
    }
  }
  return out;
}

function bm25List(idx: ReturnType<typeof buildBm25Index>, b: Awaited<ReturnType<typeof build>>, q: string): Scored[] {
  const out: Scored[] = [];
  for (const h of bm25Search(idx, q, 20)) {
    if (h.kind === "sym") {
      const s = b.graph.symbols[h.rowid];
      if (!s || s.kind === "import") continue;
      out.push({ id: s.id, file: s.file, name: s.name, reason: [], score: -h.score });
    } else {
      const d = b.docs[h.doc ?? -1];
      if (!d) continue;
      out.push({ id: `doc::${d.file}`, file: d.file, name: d.file.split("/").pop() ?? d.file, reason: [], score: -h.score });
    }
  }
  return out;
}

function rrf(lists: Scored[][], pinAuthoritative: boolean): Scored[] {
  const acc = new Map<string, Scored>();
  for (const list of lists) {
    list.forEach((x, i) => {
      const rank = pinAuthoritative && x.reason.some((r) => AUTHORITATIVE.includes(r)) ? 0 : i + 1;
      const cur = acc.get(x.id);
      acc.set(x.id, { ...x, score: (cur?.score ?? 0) + 1 / (RRF_K + rank) });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

function queryVariants(t: Task, n: number): string[] {
  if (n <= 1) return [t.query];
  const variants = [t.query, meaningfulTerms(t.query).join(" ")];
  if (n >= 3) {
    variants.push(meaningfulTerms(t.query).slice(0, 3).map((x) => `"${x}"`).join(" AND "));
  }
  return variants.slice(0, n);
}

const rows: Record<string, Record<string, { recallFiles: number; mrr: number }>> = {};

for (const t of allTasks) {
  const b = await build(taskDirs.get(t.repo)!);
  const idx = buildBm25Index(b.graph, b.docs);
  const graph = graphList(b, t);
  const graphScored = graph.map(toScored);

  const modes: Record<string, Scored[]> = {
    current: currentFusion(graph, b, idx, t),
  };
  const variants = queryVariants(t, 3);
  const bm25Lists = variants.map((q) => bm25List(idx, b, q));
  modes.rrf1 = rrf([graphScored, bm25Lists[0]], false);
  modes.rrf3 = rrf([graphScored, ...bm25Lists], false);
  modes.rrf3pin = rrf([graphScored, ...bm25Lists], true);

  rows[t.id] = {};
  for (const [name, hits] of Object.entries(modes)) {
    // measureRecall reads symbol.file/name; adapt the Scored shape
    const ranked = hits.map((s) => ({ symbol: { file: s.file, name: s.name }, score: s.score }));
    const m = measureRecall(ranked, t);
    rows[t.id][name] = { recallFiles: m.recallFiles, mrr: m.mrr };
  }
}

const names = ["current", "rrf1", "rrf3", "rrf3pin"];
const sum = Object.fromEntries(names.map((n) => [n, { recallFiles: 0, mrr: 0 }]));
let n = 0;
for (const [id, m] of Object.entries(rows)) {
  n++;
  console.log(
    `  ${id.padEnd(13)} ` +
      names.map((name) => `${name.padEnd(8)} ${(m[name].recallFiles * 100).toFixed(0).padStart(3)}%/${m[name].mrr.toFixed(2).padStart(5)}`).join(" "),
  );
  for (const name of names) {
    sum[name].recallFiles += m[name].recallFiles;
    sum[name].mrr += m[name].mrr;
  }
}
console.log(`\navg (${n} tasks):`);
for (const name of names) {
  console.log(`  ${name.padEnd(8)} files ${((sum[name].recallFiles / n) * 100).toFixed(1)}%  mrr ${(sum[name].mrr / n).toFixed(3)}`);
}

await fs.writeFile(path.join(import.meta.dir, "..", "var", "fusion-experiment.json"), JSON.stringify({ real: useReal, rows, sums: sum }, null, 2));
console.log("\nraw -> var/fusion-experiment.json");
