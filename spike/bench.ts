import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { rankSymbols } from "../src/query";
import { assemble } from "../src/assemble";
import { renderCapsule } from "../src/render";
import { loadCache } from "../src/cache";
import { runHook } from "../src/hook";
import { changedFiles } from "../src/diff";

const here = import.meta.dir;
const fixtures = {
  go: path.join(here, "fixtures", "go"),
  typescript: path.join(here, "fixtures", "typescript"),
  python: path.join(here, "fixtures", "python"),
};

interface Measurements {
  env: { bun: string; platform: string; arch: string };
  perFixture: Record<string, FixtureMeasure>;
  coldScanMs: number;
  warmQueryMs: number;
  incremental: { parsed: number; reused: number; refreshMs: number };
  cacheReloadParsed: number;
  deterministic: boolean;
  hookMs: number;
  startupMs: number;
  binarySizeBytes: number;
  binaryRunMs: number;
  peakRssMb: number;
  failures: string[];
  budgets: { warmQueryMs: number; incrementalScanMs: number; coldFixtureMs: number; hookMs: number };
}

interface FixtureMeasure {
  files: number;
  symbols: number;
  edges: number;
  coldMs: number;
  warmMs: number;
  topHit: string;
}

async function measureFixture(fixturesRoot: string): Promise<FixtureMeasure> {
  const b = await build(fixturesRoot);
  const hits = rankSymbols({
    task: "where is session persistence handled?",
    graph: b.graph,
    changed: new Set(),
    explicitFiles: [],
  });
  const top = hits[0];
  return {
    files: b.files.length,
    symbols: b.graph.symbols.length,
    edges: b.graph.edges.length,
    coldMs: Math.round(b.totalMs),
    warmMs: 0,
    topHit: top ? `${top.symbol.file}:${top.symbol.nameLine}` : "(none)",
  };
}

async function warmRun(root: string): Promise<number> {
  const b = await build(root);
  const hits = rankSymbols({ task: "where is session persistence handled?", graph: b.graph, changed: new Set(), explicitFiles: [] });
  const capsule = assemble({ task: "where is session persistence handled?", build: b, hits, budgetTokens: 1200 });
  return Math.round(performance.now());
}

async function main(): Promise<void> {
  const m: Measurements = {
    env: { bun: Bun.version, platform: process.platform, arch: process.arch },
    perFixture: {},
    coldScanMs: 0,
    warmQueryMs: 0,
    incremental: { parsed: 0, reused: 0, refreshMs: 0 },
    cacheReloadParsed: 0,
    deterministic: false,
    hookMs: 0,
    startupMs: 0,
    binarySizeBytes: 0,
    binaryRunMs: 0,
    peakRssMb: 0,
    failures: [],
    budgets: { warmQueryMs: 150, incrementalScanMs: 500, coldFixtureMs: 2000, hookMs: 1000 },
  };

  try {
    // 1-4: scan/parse/cache/query per fixture (cold), then warm timing
    const t0 = performance.now();
    for (const [name, root] of Object.entries(fixtures)) {
      const t = performance.now();
      const fm = await measureFixture(root);
      fm.coldMs = Math.round(performance.now() - t);
      m.perFixture[name] = fm;
    }
    m.coldScanMs = Math.round(performance.now() - t0);

    // warm query timing on the largest fixture
    {
      const t = performance.now();
      await warmRun(fixtures.typescript);
      m.warmQueryMs = Math.round(performance.now() - t);
    }

    // cache reload: second build should parse 0 files
    {
      const b = await build(fixtures.go);
      m.cacheReloadParsed = b.parsed;
    }

    // incremental: one-file change in a scratch copy
    {
      const scratch = path.join(here, "..", "..", "..", "var", "spike-scratch");
      const src = fixtures.python;
      await fs.rm(scratch, { recursive: true, force: true });
      await fs.cp(src, scratch, { recursive: true });
      const b1 = await build(scratch);
      const file = path.join(scratch, "app", "session", "store.py");
      await fs.appendFile(file, "\n# spike: incremental edit\n");
      const t = performance.now();
      const b2 = await build(scratch);
      m.incremental = { parsed: b2.parsed, reused: b2.reused, refreshMs: Math.round(b2.refreshMs) };
      const delta = Math.round(performance.now() - t);
      void delta;
      await fs.rm(scratch, { recursive: true, force: true });
    }

    // deterministic: two queries, identical output
    {
      const b = await build(fixtures.typescript);
      const q = "where is session persistence handled?";
      const h1 = rankSymbols({ task: q, graph: b.graph, changed: new Set(), explicitFiles: [] });
      const h2 = rankSymbols({ task: q, graph: b.graph, changed: new Set(), explicitFiles: [] });
      const c1 = JSON.stringify(assemble({ task: q, build: b, hits: h1, budgetTokens: 1200 }).hits);
      const c2 = JSON.stringify(assemble({ task: q, build: b, hits: h2, budgetTokens: 1200 }).hits);
      m.deterministic = c1 === c2;
    }

    // hook: UserPromptSubmit adapter wall time + fail-open
    {
      const t = performance.now();
      await runHook("Refactor the session store so persistence is handled consistently across all clients. The current code keeps multiple copies of the store open.", fixtures.typescript, { exit: false });
      m.hookMs = Math.round(performance.now() - t);
    }

    // standalone binary: compile + run, size + startup
    try {
      // first verify bun-compiled binaries exec at all on this host
      const mini = path.join(here, "..", "..", "..", "var", "mini-bin");
      await fs.mkdir(path.dirname(mini), { recursive: true });
      await fs.writeFile(mini + ".ts", 'console.log("mini-ok");\n');
      await Bun.$`bun build --compile ${mini}.ts --outfile ${mini}`.quiet();
      const probe = Bun.spawn({ cmd: [mini], stdout: "pipe", stderr: "pipe" });
      const probeCode = await probe.exited;
      await fs.rm(mini, { force: true });
      await fs.rm(mini + ".ts", { force: true });
      if (probeCode !== 0) {
        throw new Error(
          `bun-compiled binaries are SIGKILL'd on exec in this host (probe exit ${probeCode}); standalone packaging cannot be verified here — needs a host without the sandbox or a stable Bun release`,
        );
      }

      const grammars = path.join(here, "grammars");
      const gStat = await fs.stat(path.join(grammars, "tree-sitter-go", "tree-sitter-go.wasm")).catch(() => null);
      if (!gStat) {
        const emb = Bun.spawn({ cmd: ["bun", "run", "scripts/embed-grammars.ts"], cwd: path.join(here, ".."), stdout: "pipe", stderr: "pipe" });
        await emb.exited;
      }
      const outfile = path.join(here, "context-bin");
      await fs.rm(outfile, { force: true });
      const comp = Bun.spawn({
        cmd: ["bun", "build", "--compile", "src/cli.ts", "--outfile", outfile],
        cwd: path.join(here, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const cerr = await new Response(comp.stderr).text();
      const ccode = await comp.exited;
      if (ccode !== 0) throw new Error("compile failed: " + cerr);
      m.binarySizeBytes = (await fs.stat(outfile)).size;

      const tS = performance.now();
      const run = Bun.spawn({ cmd: [outfile, "prepare", "where is session persistence handled?", "--root", fixtures.go], stdout: "pipe", stderr: "pipe" });
      const out = await new Response(run.stdout).text();
      const rcode = await run.exited;
      m.binaryRunMs = Math.round(performance.now() - tS);
      if (rcode !== 0) throw new Error("binary run failed");
      m.startupMs = m.binaryRunMs;
      if (!/OpenStore/.test(out)) throw new Error("binary output missing expected symbol");
      // strip node_modules dependence: run from a dir without node_modules access
      const tmp = path.join(here, "..", "..", "..", "var", "spike-nm");
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.mkdir(tmp, { recursive: true });
      const run2 = Bun.spawn({ cmd: [outfile, "prepare", "session store", "--root", fixtures.typescript], cwd: tmp, stdout: "pipe", stderr: "pipe" });
      const out2 = await new Response(run2.stdout).text();
      await run2.exited;
      if (!/openStore/.test(out2)) throw new Error("binary failed without node_modules");
      await fs.rm(tmp, { recursive: true, force: true });
    } catch (e) {
      m.failures.push("standalone binary: " + String(e));
    }

    // startup fallback: bun runner cold start of --help
    if (m.startupMs === 0) {
      const t = performance.now();
      const p = Bun.spawn({ cmd: ["bun", "run", "src/cli.ts", "--help"], cwd: path.join(here, ".."), stdout: "pipe", stderr: "pipe" });
      await new Response(p.stdout).text();
      await p.exited;
      m.startupMs = Math.round(performance.now() - t);
    }

    m.peakRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch (e) {
    m.failures.push(String(e));
  }

  const out = path.join(here, "results.json");
  await fs.writeFile(out, JSON.stringify(m, null, 2));
  console.log(JSON.stringify(m, null, 2));
}

await main();
