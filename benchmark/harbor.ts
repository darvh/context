import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Official Terminal-Bench 2.1 runner via Harbor + opencode.
 *
 * Runs the frozen tb21-fixture.yaml subset with the official verifier inside
 * each task's Docker image. Requires Docker on the host. Cold arm is a single
 * `harbor run`; the context arm needs a custom harbor agent wrapper that
 * injects the Context capsule into the containerized opencode (WIP).
 *
 *   bun run benchmark/harbor.ts [--arm cold] [--dry-run] [--reps N] [--out DIR]
 */

interface Fixture {
  model: { id: string; usage_multiplier: number; dataset: string; n_concurrent: number; reps: number };
  tasks: { name: string; difficulty: string; category: string; image: string; digest: string; golden: string[]; why: string }[];
  arms: Record<string, { label: string; command: string; enabled: boolean }>;
}

const BENCH = import.meta.dir;
const OUT = path.join(BENCH, "raw", "harbor");

function parse(argv: string[]) {
  const a: { arm: string; dry: boolean; reps: number | null; out: string; tasks: string[] } = {
    arm: "cold",
    dry: false,
    reps: null,
    out: OUT,
    tasks: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--arm") a.arm = argv[++i];
    else if (x === "--dry-run") a.dry = true;
    else if (x === "--reps") a.reps = Number(argv[++i]);
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--tasks") a.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--help") { console.log(help); process.exit(0); }
  }
  return a;
}

const help = `context harbor runner — official Terminal-Bench 2.1 via Harbor + opencode

usage: bun run benchmark/harbor.ts [--arm cold|context] [--dry-run] [--reps N] [--out DIR] [--tasks a,b]

  --dry-run  print the exact harbor command without running it
`;

async function main(argv: string[]) {
  const a = parse(argv);
  const raw = await fs.readFile(path.join(BENCH, "tb21-fixture.yaml"), "utf8");
  const fx = Bun.YAML.parse(raw) as unknown as Fixture;

  const arm = fx.arms[a.arm];
  if (!arm || !arm.enabled) {
    console.error(`[harbor] arm "${a.arm}" not enabled in tb21-fixture.yaml`);
    process.exit(1);
  }
  const tasks = fx.tasks.filter((t) => !a.tasks.length || a.tasks.includes(t.name)).map((t) => t.name);
  if (!tasks.length) {
    console.error("[harbor] no tasks matched");
    process.exit(1);
  }
  const reps = a.reps ?? fx.model.reps;
  const jobsDir = path.join(a.out, a.arm);

  const glob = `terminal-bench/{${tasks.join(",")}}`;
  const cmd = [
    "harbor", "run",
    "--dataset", fx.model.dataset,
    "--include-task-name", glob,
    "--agent", "opencode",
    "--model", fx.model.id,
    "--n-concurrent", String(fx.model.n_concurrent),
    "--n-attempts", String(reps),
    "--jobs-dir", jobsDir,
    "-y",
  ];

  console.log(`[harbor] ${arm.label}  model=${fx.model.id} (usage ${fx.model.usage_multiplier}x) tasks=${tasks.length} reps=${reps}`);
  console.log(`[harbor] jobs -> ${jobsDir}`);
  console.log(`[harbor] cmd: ${cmd.join(" ")}`);

  if (a.dry) {
    console.log("[harbor] dry-run; nothing run");
    return;
  }

  if (process.env.DOCKER_HOST || !(await dockerAvailable())) {
    console.error("[harbor] docker not available on this host — cannot run; use --dry-run");
    process.exit(1);
  }

  await fs.mkdir(jobsDir, { recursive: true });
  const p = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit", detached: true });
  p.unref();
  const code = await p.exited;
  process.exit(code ?? 0);
}

async function dockerAvailable(): Promise<boolean> {
  const p = Bun.spawn({ cmd: ["docker", "info"], stdout: "pipe", stderr: "pipe" });
  await new Response(p.stdout).text();
  return (await p.exited) === 0;
}

await main(process.argv.slice(2));
