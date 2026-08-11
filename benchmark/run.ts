import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { computeMetrics, parseTranscript, capsuleBlock, type MetricRun } from "./metrics";
import { copyRepoAndPin } from "./repo";

interface Manifest {
  model: {
    id: string;
    usage_multiplier: number;
    timeout_seconds: number;
    permission: string;
    reps: number;
  };
  arms: Record<string, { label: string; enabled: boolean }>;
  tasks: {
    id: string;
    repo: string;
    revision?: string; // git revision to pin; requires a git repo
    prompt: string;
    golden: string[];
    verify_cmd?: string;
    setup_cmd?: string; // bootstrap run in the scratch dir before the agent (TB setup scripts)
  }[];
}

const ROOT = path.join(import.meta.dir, "..");
const BENCH = path.join(import.meta.dir, ".");
// Scratch MUST live outside the repository: opencode walks up from --dir and
// would otherwise detect the context repo and auto-commit into it (observed).
const SCRATCH = path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache"), "context", "bench");

interface CliArgs {
  arms: string[];
  tasks: string[];
  reps: number | null;
  dry: boolean;
  replay: boolean;
  outDir: string;
}

function parseCli(argv: string[]): CliArgs {
  const a: CliArgs = { arms: [], tasks: [], reps: null, dry: false, replay: false, outDir: BENCH };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--arms") a.arms = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--tasks") a.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--reps") a.reps = Number(argv[++i]);
    else if (x === "--dry") a.dry = true;
    else if (x === "--replay") a.replay = true;
    else if (x === "--out") a.outDir = argv[++i];
    else if (x === "--help") { console.log(help); process.exit(0); }
  }
  return a;
}

const help = `context bench — paired evaluation via opencode (deepseek-v4-flash, 2x usage)

usage: bun run benchmark/run.ts [--arms cold,context] [--tasks sess-go] [--reps N] [--dry] [--replay] [--out DIR]

  --dry     print the run plan (repos, prompts, verify) without invoking models
  --replay  rebuild metrics + reports from existing raw transcripts (no model cost)
`;

async function readManifest(): Promise<Manifest> {
  const raw = await fs.readFile(path.join(BENCH, "manifest.yaml"), "utf8");
  return Bun.YAML.parse(raw) as unknown as Manifest;
}

function runId(arm: string, task: string, rep: number): string {
  return `${arm}-${task}-r${rep}`;
}

// opencode runs in its own process group (detached) so a hung run can be
// killed group-wide instead of orphaning children that hold the shared
// opencode.db lock and wedge every later run (observed).
const groups = new Set<number>();
function spawnGroup(cmd: string[], opts: { cwd: string; stdout: "pipe"; stderr: "pipe" }): ReturnType<typeof Bun.spawn> {
  const p = Bun.spawn({ cmd, ...opts, detached: true });
  groups.add(p.pid);
  return p;
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  groups.delete(pid);
}
function killAllGroups(): void {
  for (const pid of groups) killGroup(pid);
}
process.on("exit", killAllGroups);
process.on("SIGINT", () => { killAllGroups(); process.exit(130); });
process.on("SIGTERM", () => { killAllGroups(); process.exit(143); });

async function runVerify(cmd: string | undefined, dir: string): Promise<{ status: boolean | null; out: string }> {
  if (!cmd) return { status: null, out: "" };
  try {
    const p = Bun.spawn({ cmd: cmd.split(/\s+/), cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    const code = await p.exited;
    return { status: code === 0, out };
  } catch (e) {
    return { status: false, out: String(e) };
  }
}

async function runOc(
  args: CliArgs,
  manifest: Manifest,
  arm: string,
  task: Manifest["tasks"][number],
  rep: number,
): Promise<MetricRun> {
  const id = runId(arm, task.id, rep);
  const scratch = path.join(SCRATCH, id);
  const rawDir = path.join(args.outDir, "raw", arm, task.id);
  const rawFile = path.join(rawDir, `${id}.jsonl`);
  await fs.mkdir(rawDir, { recursive: true });

  await copyRepoAndPin(task.repo, task.revision, scratch);

  if (task.setup_cmd && !args.dry) {
    const s = await runVerify(task.setup_cmd, scratch);
    if (s.status === false) {
      console.error(`[bench] ${id}: setup failed\n${s.out.slice(0, 800)}`);
    }
  }

  let prompt = task.prompt;
  let capsuleTokens = 0;
  if (arm === "context") {
    const b = await build(scratch);
    const { block, tokens } = await capsuleBlock(b, task.prompt);
    capsuleTokens = tokens;
    prompt = block + "\n\n" + prompt;
  }

  const t0 = Date.now();
  let status: "ok" | "timeout" | "error" = "ok";
  let stdout = "";
  if (!args.dry) {
    const cmd = [
      "opencode",
      "run",
      "--format", "json",
      "-m", manifest.model.id,
      "--dir", scratch,
      "--title", id,
      "--auto",
      prompt,
    ];
    const p = spawnGroup(cmd, { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    const killTimer = setTimeout(() => {
      status = "timeout";
      killGroup(p.pid);
    }, manifest.model.timeout_seconds * 1000);
    try {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      stdout = out;
      const code = await p.exited;
      if (code !== 0 && status !== "timeout") {
        status = "error";
        console.error(`[bench] ${id}: opencode exited non-zero\n${err.slice(0, 800)}`);
      }
    } finally {
      clearTimeout(killTimer);
      killGroup(p.pid);
    }
  }
  const wallMs = Date.now() - t0;

  await fs.writeFile(rawFile, stdout);

  const transcript = parseTranscript(stdout.split("\n"));
  const goldenFiles = new Set(task.golden.map((g) => g.split(":")[0]));
  const { status: verifyStatus, out: verifyOut } = status === "ok" ? await runVerify(task.verify_cmd, scratch) : { status: null, out: "" };
  const m = computeMetrics(transcript, {
    goldenFiles,
    runStart: transcript.firstTs || t0,
    usageMultiplier: manifest.model.usage_multiplier,
  }, { capsuleTokens, wallMs, editedGolden: false, verifyStatus, verifyOutput: verifyOut });

  m.arm = arm;
  m.task = task.id;
  m.rep = rep;
  m.status = status;
  m.success = verifyStatus;

  // sidecar for --replay (no model cost)
  await fs.writeFile(
    path.join(rawDir, `${id}.meta.json`),
    JSON.stringify({ arm, task: task.id, rep, status, revision: task.revision ?? null, capsuleTokens, wallMs, verifyStatus, verifyOutput: verifyOut }),
  );
  return m;
}

/** Rebuild metrics + reports from existing raw transcripts and sidecars. */
async function replay(args: CliArgs, manifest: Manifest): Promise<MetricRun[]> {
  const runs: MetricRun[] = [];
  const rawRoot = path.join(args.outDir, "raw");
  for (const arm of Object.keys(manifest.arms)) {
    const armDir = path.join(rawRoot, arm);
    let tasks: string[];
    try {
      tasks = await fs.readdir(armDir);
    } catch {
      continue;
    }
    for (const taskDir of tasks) {
      if (args.tasks.length && !args.tasks.includes(taskDir)) continue;
      const t = manifest.tasks.find((x) => x.id === taskDir);
      if (!t) continue;
      const files = (await fs.readdir(path.join(armDir, taskDir))).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const id = f.replace(/\.jsonl$/, "");
        const meta = await fs.readFile(path.join(armDir, taskDir, `${id}.meta.json`), "utf8").then(JSON.parse).catch(() => null);
        const lines = (await fs.readFile(path.join(armDir, taskDir, f), "utf8")).split("\n");
        const tr = parseTranscript(lines);
        const goldenFiles = new Set(t.golden.map((g) => g.split(":")[0]));
        const m = computeMetrics(tr, {
          goldenFiles,
          runStart: tr.firstTs || 0,
          usageMultiplier: manifest.model.usage_multiplier,
        }, {
          capsuleTokens: meta?.capsuleTokens ?? 0,
          wallMs: meta?.wallMs ?? 0,
          editedGolden: false,
          verifyStatus: meta?.verifyStatus ?? null,
          verifyOutput: meta?.verifyOutput ?? "",
        });
        m.arm = arm;
        m.task = t.id;
        m.rep = Number(id.split("-").pop()?.replace("r", "") ?? 0);
        m.status = meta?.status ?? "ok";
        m.success = meta?.verifyStatus ?? null;
        runs.push(m);      }
    }
  }
  return runs;
}

export async function main(argv: string[]) {
  const args = parseCli(argv);
  const manifest = await readManifest();

  if (args.replay) {
    const runs = await replay(args, manifest);
    if (!runs.length) { console.error("no raw transcripts found under", args.outDir); process.exit(1); }
    const { writeReport } = await import("./report");
    await writeReport(runs, args.outDir, manifest);
    console.log(`[replay] rebuilt reports from ${runs.length} runs`);
    return;
  }

  const tasks = manifest.tasks.filter((t) => !args.tasks.length || args.tasks.includes(t.id));
  const arms = Object.entries(manifest.arms)
    .filter(([id, a]) => a.enabled && (!args.arms.length || args.arms.includes(id)))
    .map(([id]) => id);

  if (!tasks.length) { console.error("no tasks matched"); process.exit(1); }
  if (!arms.length) { console.error("no arms enabled (manifest or --arms)"); process.exit(1); }

  const reps = args.reps ?? manifest.model.reps;
  console.log(`[bench] model=${manifest.model.id} usage_multiplier=${manifest.model.usage_multiplier} arms=${arms.join(",")} tasks=${tasks.map((t) => t.id).join(",")} reps=${reps}`);

  const runs: MetricRun[] = [];
  for (const arm of arms) {
    for (const task of tasks) {
      for (let rep = 1; rep <= reps; rep++) {
        if (args.dry) {
          console.log(`[dry] ${runId(arm, task.id, rep)} repo=${task.repo} rev=${task.revision ?? "-"} setup=${task.setup_cmd ?? "-"} verify=${task.verify_cmd ?? "-"}`);
          continue;
        }
        console.log(`[bench] running ${runId(arm, task.id, rep)} ...`);
        try {
          runs.push(await runOc(args, manifest, arm, task, rep));
        } catch (e) {
          console.error(`[bench] ${runId(arm, task.id, rep)} failed: ${e}`);
          runs.push({
            arm, task: task.id, rep, status: "error", success: null, editedGolden: false,
            firstRelevantMs: null, firstRelevantFile: null, firstEditMs: null,
            explorationBeforeFirstEdit: 0, firstRelevantCalls: 0, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, totalTokens: 0, costUsd: 0, wallMs: 0, capsuleTokens: 0,
            rawTokensInput: 0, rawTokensOutput: 0, rawCostUsd: 0, failureCategory: "environment", verifyOutput: String(e),
          });
        }
      }
    }
  }

  if (!args.dry && runs.length) {
    // rebuild the report from ALL raw transcripts so cells accumulate
    const all = await replay(args, manifest);
    const { writeReport } = await import("./report");
    await writeReport(all.length ? all : runs, args.outDir, manifest);
  } else if (args.dry) {
    console.log("[dry] plan complete; nothing run");
  }
}

await main(process.argv.slice(2));
