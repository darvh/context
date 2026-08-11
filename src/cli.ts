import path from "node:path";
import { build } from "./build";
import { rankSymbols, explicitFilesFromTask } from "./query";
import { assemble, type Capsule } from "./assemble";
import { renderCapsule, capsuleToJson } from "./render";
import { resolveExpand, renderExpanded } from "./expand";
import { impact, renderImpact, type ImpactReport } from "./impact";
import { changedFiles } from "./diff";
import { lastCapsulePath, writeJson } from "./cache";
import { estTokens } from "./tokens";

const HELP = `context — deterministic discovery compiler

usage:
  context prepare "<task>" [--budget N] [--json] [--root DIR]
  context expand <handle|file:line> [--root DIR]
  context impact <symbol|--diff> [--json] [--root DIR]
  context init [--targets all|opencode,claude-code,codex,cursor,copilot,antigravity]
               [--project] [--force] [--dry-run] [--hooks]
  context --help
`;

interface Args {
  root: string;
  budget: number;
  json: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: process.cwd(), budget: 1200, json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budget") args.budget = Number(argv[++i]) || 1200;
    else if (a === "--json") args.json = true;
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a.startsWith("--root=")) args.root = path.resolve(a.slice(7));
    else if (a.startsWith("--budget=")) args.budget = Number(a.slice(9)) || 1200;
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else args.rest.push(a);
  }
  return args;
}

async function cmdPrepare(args: Args) {
  const t0 = performance.now();
  const task = args.rest.join(" ").trim() || args.rest[0] || "";
  const b = await build(args.root);
  const changed = await changedFiles(b.root);
  const explicit = explicitFilesFromTask(task, b.files);
  const hits = rankSymbols({ task, graph: b.graph, changed, explicitFiles: explicit });
  const capsule = assemble({ task, build: b, hits, budgetTokens: args.budget });
  await writeJson(lastCapsulePath(), capsule);
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
  const e = await resolveExpand(args.root, handle);
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
  const b = await build(args.root);
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
  const repo = project ? (await (await import("./scan")).findRoot(args.root)) ?? args.root : "";
  const { init, agentPaths } = await import("./init");
  console.log(`context init (targets: ${targets}, ${project ? "project" : "user"} scope${hooks ? ", hooks" : ""})`);
  for (const r of await init({ project, repo, force, dryRun, only, hooks })) {
    const note = r.note ? ` ${r.note}` : "";
    const loc = r.status === "unselected" ? "" : r.dir;
    console.log(`  ${r.agent.padEnd(11)}  ${r.what.padEnd(12)}  ${r.status.padEnd(10)}  ${loc}${note}`);
  }
  if (project && repo) console.log(`project skill dirs: ${agentPaths({ project, repo, force, dryRun, only, hooks }).join(", ")}`);
}

export async function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = args.rest[0] ?? "";
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "prepare") {
    args.rest.shift();
    await cmdPrepare(args);
  } else if (cmd === "expand") {
    args.rest.shift();
    await cmdExpand(args);
  } else if (cmd === "impact") {
    args.rest.shift();
    await cmdImpact(args);
  } else if (cmd === "init") {
    args.rest.shift();
    await cmdInit(args, args.rest);
  } else {
    console.error(`context: unknown command "${cmd}"\n`);
    console.error(HELP);
    process.exit(1);
  }
}
