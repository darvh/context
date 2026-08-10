import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "../src/build";
import { computeMetrics, parseTranscript, capsuleBlock, type MetricRun } from "./metrics";

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
    prompt: string;
    golden: string[];
    verify_cmd?: string;
  }[];
}

const ROOT = path.join(import.meta.dir, "..");
const BENCH = path.join(import.meta.dir, ".");
const SCRATCH = path.join(ROOT, "var", "bench");

interface CliArgs {
  arms: string[];
  tasks: string[];
  reps: number | null;
  dry: boolean;
  outDir: string;
}

function parseCli(argv: string[]): CliArgs {
  const a: CliArgs = { arms: [], tasks: [], reps: null, dry: false, outDir: BENCH };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--arms") a.arms = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--tasks") a.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--reps") a.reps = Number(argv[++i]);
    else if (x === "--dry") a.dry = true;
    else if (x === "--out") a.outDir = argv[++i];
    else if (x === "--help") { console.log(help); process.exit(0); }
  }
  return a;
}

const help = `context bench — paired evaluation via opencode (deepseek-v4-flash, 2x usage)

usage: bun run benchmark/run.ts [--arms cold,context] [--tasks sess-go] [--reps N] [--dry] [--out DIR]

  --dry   print the run plan (repos, prompts, verify) without invoking models
`;

async function readManifest(): Promise<Manifest> {
  const raw = await fs.readFile(path.join(BENCH, "manifest.yaml"), "utf8");
  return Bun.YAML.parse(raw) as unknown as Manifest;
}

function runId(arm: string, task: string, rep: number): string {
  return `${arm}-${task}-r${rep}`;
}

async function copyRepo(repoRel: string, dest: string): Promise<void> {
  const src = path.resolve(ROOT, repoRel);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

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

  await copyRepo(task.repo, scratch);

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
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", cwd: ROOT });
    const killTimer = setTimeout(() => {
      status = "timeout";
      p.kill();
    }, manifest.model.timeout_seconds * 1000);
    try {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      stdout = out;
      if ((await p.exited) !== 0 && status !== "timeout") {
        status = "error";
        console.error(`[bench] ${id}: opencode exited non-zero\n${err.slice(0, 800)}`);
      }
    } finally {
      clearTimeout(killTimer);
    }
  }
  const wallMs = Date.now() - t0;

  await fs.writeFile(rawFile, stdout);

  const transcript = parseTranscript(stdout.split("\n"));
  const goldenFiles = new Set(task.golden.map((g) => g.split(":")[0]));
  const { status: verifyStatus, out: verifyOut } = status === "ok" ? await runVerify(task.verify_cmd, scratch) : { status: null, out: "" };
  const editedGolden = false; // refined from transcript below via computeMetrics? no; placeholder
  const m = computeMetrics(transcript, {
    goldenFiles,
    runStart: transcript.firstTs || t0,
    usageMultiplier: manifest.model.usage_multiplier,
  }, { capsuleTokens, wallMs, editedGolden, verifyStatus, verifyOutput: verifyOut });

  m.arm = arm;
  m.task = task.id;
  m.rep = rep;
  m.status = status;
  m.success = verifyStatus;
  return m;
}

export async function main(argv: string[]) {
  const args = parseCli(argv);
  const manifest = await readManifest();
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
          console.log(`[dry] ${runId(arm, task.id, rep)} repo=${task.repo} verify=${task.verify_cmd ?? "-"}`);
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
    const { writeReport } = await import("./report");
    await writeReport(runs, args.outDir, manifest);
  } else if (args.dry) {
    console.log("[dry] plan complete; nothing run");
  }
}

await main(process.argv.slice(2));
