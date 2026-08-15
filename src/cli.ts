import path from "node:path";
import { build } from "./build";
import { rankSymbols, explicitFilesFromTask, queryConfidence } from "./query";
import { assemble, type Capsule } from "./assemble";
import { renderCapsule, capsuleToJson } from "./render";
import { resolveExpand, renderExpanded } from "./expand";
import { impact, renderImpact, type ImpactReport } from "./impact";
import { changedFiles, coChangedFiles } from "./diff";
import { lastCapsulePath, writeJson, repoKey, readJson, sessionStatePath } from "./cache";
import { buildBm25Index } from "./bm25";
import { appendSemanticHits } from "./query";
import { estTokens } from "./tokens";
import { buildInfo, runtimeKind } from "./version";
import type { ScanOpts } from "./scan";

const HELP = `context — deterministic discovery compiler

usage:
  context observe "<task>" [--budget N] [--json] [--root DIR]
                [--ignore pat[,pat]] [--no-gitignore]
  context map <directory> [--root DIR]
  context follow <symbol|qualified-id> [<edge>] [--root DIR]
  context expand <handle|file:line> [--root DIR]
  context impact <symbol|qualified-id|--diff> [--json] [--root DIR]
               [--ignore pat[,pat]] [--no-gitignore]
  context init [--targets all|opencode,claude-code,codex,cursor,copilot,antigravity,pi]
               [--project] [--force] [--dry-run] [--hooks]
  context config get [key]
  context config set <key> <value>     keys: semantic on|off, model <name>
  context --help
  context --version

observe (alias: prepare) is orientation: DirMap + neighborhoods + spans.
map compiles a bounded local RepoMap over one directory. follow walks one edge
kind from a symbol (callers, callees, tests, inherit, implement, contain, ref,
import, all) with short trails. impact is the symbol map + diff. expand is
exact span evidence.

ignore override:
  --ignore "a,b"   add extra ignore globs (on top of .gitignore + defaults)
  --no-gitignore   do not read .gitignore files (default ignores still apply)
`;

interface Args {
  root: string;
  budget: number;
  json: boolean;
  rest: string[];
  scan: ScanOpts;
}

async function parseArgs(argv: string[]): Promise<Args> {
  const args: Args = { root: process.cwd(), budget: 1200, json: false, rest: [], scan: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budget") args.budget = Number(argv[++i]) || 1200;
    else if (a === "--json") args.json = true;
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a.startsWith("--root=")) args.root = path.resolve(a.slice(7));
    else if (a.startsWith("--budget=")) args.budget = Number(a.slice(9)) || 1200;
    else if (a === "--no-gitignore") args.scan.noGitignore = true;
    else if (a === "--ignore") args.scan.ignore = [...(args.scan.ignore ?? []), ...(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
    else if (a.startsWith("--ignore=")) args.scan.ignore = [...(args.scan.ignore ?? []), ...a.slice(9).split(",").map((s) => s.trim()).filter(Boolean)];
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else if (a === "--version" || a === "-v") { console.log(await buildInfo()); process.exit(0); }
    else args.rest.push(a);
  }
  return args;
}

async function cmdPrepare(args: Args) {
  const t0 = performance.now();
  const task = args.rest.join(" ").trim() || args.rest[0] || "";
  const b = await build(args.root, args.scan);
  const changed = await changedFiles(b.root);
  const explicit = explicitFilesFromTask(task, b.files);
  const bm25 = b.graph.symbols.length || b.docs.length ? buildBm25Index(b.graph, b.docs) : undefined;
  // history lane: co-change facts are git-only and only consulted when the
  // task is explicitly about history/regression
  const historyIntent = /\b(why did|when did|history|regression|introduced(?: by)?|co-?changed)\b/i.test(task);
  const coChanged = historyIntent ? await coChangedFiles(b.root) : undefined;
  let hits = rankSymbols({ task, graph: b.graph, changed, explicitFiles: explicit, bm25, docs: b.docs, coChanged });

  // session-delta: symbols already shown to the agent in this task session are
  // down-weighted (novelty); the disposable session state is keyed by tree
  const session = await readJson<{ tree: string; seen: string[] }>(sessionStatePath(b.repoRoot));
  const seen = session && session.tree === b.treeHash ? new Set(session.seen) : undefined;

  // pipeline: exact/lexical -> confidence gate -> semantic lane (opt-in).
  // The gate decides whether semantic candidates are consulted at all: a
  // strong lexical pass never pays the embedding cost.
  let semanticDirs: { path: string; sim: number }[] | undefined;
  let semStats: { model: string; hits: number; dirs: number; ms: number } | undefined;
  if (queryConfidence(hits) !== "strong") {
    const sem = await import("./semantic");
    if (await sem.semanticEnabled()) {
      if (runtimeKind() === "compiled") {
        // explicit runtime boundary: the compiled binary cannot load the ONNX
        // runtime from the bundle; the source entrypoint (launcher fallback)
        // can. Degrade loudly, never silently.
        console.error("context: semantic fallback unavailable in the compiled runtime (embedding runtime not bundled); use the Bun source entrypoint or unset semantic");
      } else {
        const t1 = performance.now();
        const res = await sem.semanticSearch(b.root, b.graph, b.docs, task, { repoKey: repoKey(b.root) });
        if (res) {
          if (res.symbols.length) hits = appendSemanticHits(hits, res.symbols, b.graph, b.docs, task);
          semanticDirs = res.dirs;
        }
        semStats = { model: await sem.modelName(), hits: res?.symbols.length ?? 0, dirs: res?.dirs.length ?? 0, ms: Math.round(performance.now() - t1) };
      }
    }
  }
  const capsule = assemble({ task, build: b, hits, budgetTokens: args.budget, changed, semanticDirs, seen });
  try {
    await writeJson(lastCapsulePath(b.repoRoot), capsule);
    // record what this observation showed, for the next one in this session
    await writeJson(sessionStatePath(b.repoRoot), { tree: b.treeHash, seen: capsule.hits.map((h) => `${h.file}:${h.line}`) }).catch(() => {});
  } catch {
    // capsule write failure is recoverable: output still goes to stdout
  }
  const out = args.json ? capsuleToJson(capsule) : renderCapsule(capsule);
  const totalMs = performance.now() - t0;
  const tel = {
    cmd: "prepare",
    totalMs: Math.round(totalMs),
    parseMs: Math.round(b.parseMs),
    refreshMs: Math.round(b.refreshMs),
    files: b.files.length,
    parsed: b.parsed,
    reused: b.reused,
    symbols: b.graph.symbols.length,
    edges: b.graph.edges.length,
    capsuleTokens: capsule.tokensUsed,
    outputTokens: estTokens(out),
    sourceCacheMiss: b.sourceCacheMiss,
    sem: semStats,
  };
  console.error("context:telemetry " + JSON.stringify(tel));
  process.stdout.write(out);
}

async function cmdExpand(args: Args) {
  const handle = args.rest[0];
  if (!handle) {
    console.error(HELP);
    process.exit(1);
  }
  // capsule + file:line handles are repo-relative: resolve against the walked root
  const root = (await (await import("./scan")).findRoot(args.root)) ?? args.root;
  const e = await resolveExpand(root, handle);
  if (!e) {
    console.error("context: no such handle (run `context prepare` first, or pass file:line)");
    process.exit(1);
  }
  process.stdout.write(renderExpanded(e));
}

async function cmdImpact(args: Args) {
  const t0 = performance.now();
  const arg = args.rest[0];
  const diffOnly = arg === "--diff" || arg === "diff";
  const b = await build(args.root, args.scan);
  const changed = await changedFiles(b.root);
  b.changed = changed;
  const r: ImpactReport = impact(b, diffOnly ? undefined : arg, diffOnly);
  const out = args.json ? JSON.stringify(r, null, 2) : renderImpact(r, diffOnly);
  const tel = {
    cmd: "impact",
    totalMs: Math.round(performance.now() - t0),
    files: b.files.length,
    symbols: b.graph.symbols.length,
    outputTokens: estTokens(out),
  };
  console.error("context:telemetry " + JSON.stringify(tel));
  process.stdout.write(out);
}

async function cmdMap(args: Args) {
  const arg = args.rest[0];
  if (!arg) {
    console.error("usage: context map <directory>");
    process.exit(1);
  }
  const b = await build(args.root, args.scan);
  const dirArg = arg.endsWith("/") ? arg.slice(0, -1) : arg;
  const { mapDir } = await import("./repo-map");
  const { blocks, truncated } = mapDir(b, dirArg);
  const out: string[] = [];
  if (!blocks.length) {
    out.push(`no code symbols under ${arg}`);
  }
  for (const blk of blocks) {
    out.push(`\n${blk.file}`);
    for (const s of blk.syms) out.push(`  ${s.kind} ${s.name}  ${s.sig}  ${s.nameLine}-${s.span.el}`);
    for (const c of blk.calls) out.push(`    calls → ${c}`);
    for (const t of blk.testedBy) out.push(`    tested_by → ${t}`);
  }
  if (truncated) out.push(`\n(truncated at ${12} files — map a subdirectory for more)`);
  console.error("context:telemetry " + JSON.stringify({ cmd: "map", dir: dirArg, files: blocks.length, outputTokens: estTokens(out.join("\n")) }));
  process.stdout.write(out.join("\n") + "\n");
}

async function cmdFollow(args: Args) {
  const symbol = args.rest[0];
  const edge = args.rest[1] ?? "all";
  if (!symbol) {
    console.error("usage: context follow <symbol|qualified-id> [<symbol2>|edge]");
    process.exit(1);
  }
  const b = await build(args.root, args.scan);
  const { follow, renderFollow, connectSeeds, renderConnections, EDGE_KINDS, resolveSymbol } = await import("./follow");
  // two symbols: render the minimal connecting subgraph instead of trails
  const second = args.rest[1];
  if (second && !(EDGE_KINDS as readonly string[]).includes(second)) {
    const a = resolveSymbol(b, symbol);
    const c = resolveSymbol(b, second);
    if (!a.sym || !c.sym) {
      console.error("context: cannot resolve one of the two symbols");
      process.exit(1);
    }
    const conns = connectSeeds(b, [a.sym.id, c.sym.id]);
    const out = `connections between ${a.sym.name} and ${c.sym.name}:\n${renderConnections(conns)}\n`;
    console.error("context:telemetry " + JSON.stringify({ cmd: "follow-connect", a: symbol, b: second, edges: conns.length, outputTokens: estTokens(out) }));
    process.stdout.write(out);
    return;
  }
  if (edge !== "all" && !(EDGE_KINDS as readonly string[]).includes(edge)) {
    console.error(`context: unknown edge "${edge}" (known: ${EDGE_KINDS.join(", ")})`);
    process.exit(1);
  }
  const r = follow(b, symbol, edge);
  const out = renderFollow(r);
  console.error("context:telemetry " + JSON.stringify({ cmd: "follow", symbol, edge, trails: r.trails.length, outputTokens: estTokens(out) }));
  process.stdout.write(out);
}

async function cmdInit(args: Args, rest: string[]) {
  let targets = "all";
  let project = false;
  let force = false;
  let dryRun = false;
  let hooks = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--project") project = true;
    else if (a === "--force") force = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--hooks") hooks = true;
    else if (a === "--targets") targets = rest[++i] ?? "all";
    else if (a.startsWith("--targets=")) targets = a.slice(10);
  }
  const only = targets === "all" ? [] : targets.split(",").map((s) => s.trim()).filter(Boolean);
  const { init, agentPaths, AGENT_NAMES } = await import("./init");
  const unknown = only.filter((n) => !AGENT_NAMES.includes(n));
  if (unknown.length) {
    console.error(`context: unknown --targets: ${unknown.join(", ")} (known: ${AGENT_NAMES.join(", ")})`);
    process.exit(1);
  }
  const repo = project ? (await (await import("./scan")).findRoot(args.root)) ?? args.root : "";
  console.log(`context init (targets: ${targets}, ${project ? "project" : "user"} scope${hooks ? ", hooks" : ""})`);
  for (const r of await init({ project, repo, force, dryRun, only, hooks })) {
    const note = r.note ? ` ${r.note}` : "";
    const loc = r.status === "unselected" ? "" : r.dir;
    console.log(`  ${r.agent.padEnd(11)}  ${r.what.padEnd(12)}  ${r.status.padEnd(10)}  ${loc}${note}`);
  }
  if (project && repo) console.log(`project skill dirs: ${agentPaths({ project, repo, force, dryRun, only, hooks }).join(", ")}`);
}

async function cmdConfig(rest: string[]) {
  const { readConfig, setConfig, CONFIG_KEYS } = await import("./config");
  const op = rest[0];
  if (op === "get") {
    const cfg = await readConfig();
    const key = rest[1];
    if (key) {
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
        console.error(`context: unknown config key "${key}" (known: ${CONFIG_KEYS.join(", ")})`);
        process.exit(1);
      }
      const v = cfg[key as keyof typeof cfg];
      console.log(v === undefined ? "(unset)" : String(v));
    } else {
      console.log(JSON.stringify(cfg, null, 2));
    }
    return;
  }
  if (op === "set") {
    const key = rest[1];
    const value = rest[2];
    if (!key || value === undefined) {
      console.error("usage: context config set <key> <value>");
      process.exit(1);
    }
    if (key === "semantic") {
      const on = ["on", "true", "1", "yes"].includes(value.toLowerCase());
      const off = ["off", "false", "0", "no"].includes(value.toLowerCase());
      if (!on && !off) {
        console.error("context: semantic expects on|off");
        process.exit(1);
      }
      await setConfig("semantic", on ? "on" : "off");
      console.log(`context: semantic = ${on ? "on" : "off"}`);
      return;
    }
    if (key === "model") {
      await setConfig("model", value);
      console.log(`context: model = ${value}`);
      return;
    }
    console.error(`context: unknown config key "${key}" (known: ${CONFIG_KEYS.join(", ")})`);
    process.exit(1);
  }
  console.error("usage: context config get [key] | context config set <key> <value>");
  process.exit(1);
}

export async function main(argv: string[]) {
  const args = await parseArgs(argv);
  const cmd = args.rest[0] ?? "";
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "prepare" || cmd === "observe") {
    args.rest.shift();
    await cmdPrepare(args);
  } else if (cmd === "map") {
    args.rest.shift();
    await cmdMap(args);
  } else if (cmd === "follow") {
    args.rest.shift();
    await cmdFollow(args);
  } else if (cmd === "expand") {
    args.rest.shift();
    await cmdExpand(args);
  } else if (cmd === "impact") {
    args.rest.shift();
    await cmdImpact(args);
  } else if (cmd === "init") {
    args.rest.shift();
    await cmdInit(args, args.rest);
  } else if (cmd === "config") {
    args.rest.shift();
    await cmdConfig(args.rest);
  } else {
    console.error(`context: unknown command "${cmd}"\n`);
    console.error(HELP);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
