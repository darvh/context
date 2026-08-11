import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Official Terminal-Bench 2.1 runner via Harbor + opencode.
 *
 * Generates a Harbor job config that: selects the frozen tb21-fixture.yaml
 * subset, runs opencode inside each task image with the model, injects the
 * provider credentials/baseURL into the containerized opencode (opencode-go is
 * not in Harbor's provider table, so it gets no key otherwise), and sets the
 * reasoning variant. Requires Docker on the host.
 *
 *   bun run benchmark/harbor.ts [--arm cold] [--variant default|low|high|max]
 *                               [--tasks a,b] [--reps N] [--out DIR] [--dry-run]
 */

interface Fixture {
  model: { id: string; usage_multiplier: number; dataset: string; n_concurrent: number; reps: number };
  tasks: { name: string; difficulty: string; category: string; image: string; digest: string; golden: string[]; why: string }[];
  arms: Record<string, { label: string; command: string; enabled: boolean }>;
}

const BENCH = import.meta.dir;
const OUT = path.join(BENCH, "raw", "harbor");

function parse(argv: string[]) {
  const a: { arm: string; dry: boolean; reps: number | null; out: string; tasks: string[]; variant: string } = {
    arm: "cold",
    dry: false,
    reps: null,
    out: OUT,
    tasks: [],
    variant: "high",
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--arm") a.arm = argv[++i];
    else if (x === "--variant") a.variant = argv[++i];
    else if (x === "--dry-run") a.dry = true;
    else if (x === "--reps") a.reps = Number(argv[++i]);
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--tasks") a.tasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--help") { console.log(help); process.exit(0); }
  }
  if (a.variant !== "high" && a.variant !== "max") {
    console.error(`[harbor] variant must be high or max (got "${a.variant}")`);
    process.exit(1);
  }
  return a;
}

const help = `context harbor runner — official Terminal-Bench 2.1 via Harbor + opencode

usage: bun run benchmark/harbor.ts [--arm cold] [--variant default|low|high|max] [--tasks a,b]
                                   [--reps N] [--out DIR] [--dry-run]
`;

function opencodeGoKey(): string | null {
  try {
    const auth = JSON.parse(readFileSync(path.join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]) {
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
  const key = opencodeGoKey();
  if (!key) {
    console.error("[harbor] opencode-go API key not found in ~/.local/share/opencode/auth.json");
    process.exit(1);
  }
  const reps = a.reps ?? fx.model.reps;
  // Jobs run OUTSIDE the repo: harbor writes the resolved config (with the
  // plaintext apiKey) into the job dir. Only sanitized results are copied back.
  const cacheBase = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
  const jobsDir = path.join(cacheBase, "context", "harbor", a.arm);
  const repoOut = path.join(a.out, a.arm);

  const variant = a.variant; // always set: high|max only
  // opencode-go's opencode integration does NOT read a key env var (verified:
  // fresh opencode + OPENCODE_GO_API_KEY still fails; auth.json works). The key
  // must live in the provider config. It is therefore present in the resolved
  // config.json IN THE CACHE JOB DIR ONLY; the in-place scrub + copy-back guard
  // (below) REDACT it before anything leaves the cache.
  const cfg: Record<string, unknown> = {
    job_name: `context-tb-${a.arm}`,
    jobs_dir: jobsDir,
    n_attempts: reps,
    n_concurrent_trials: fx.model.n_concurrent,
    quiet: true,
    datasets: [{ name: fx.model.dataset, task_names: tasks.map((t) => `terminal-bench/${t}`) }],
    agents: [
      {
        name: "opencode",
        model_name: fx.model.id,
        kwargs: {
          variant,
          opencode_config: {
            provider: {
              "opencode-go": {
                options: { baseURL: "https://opencode.ai/zen/go/v1", apiKey: key },
              },
            },
          },
        },
      },
    ],
  };
  const cfgPath = path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "context", "harbor-job-config.yaml");
  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

  console.log(`[harbor] ${arm.label}  model=${fx.model.id} (usage ${fx.model.usage_multiplier}x) variant=${a.variant} tasks=${tasks.length} reps=${reps}`);
  console.log(`[harbor] jobs -> ${jobsDir}`);
  console.log(`[harbor] config -> ${cfgPath}`);
  if (a.dry) {
    console.log("[harbor] dry-run; nothing run");
    return;
  }
  await fs.rm(jobsDir, { recursive: true, force: true });

  const p = Bun.spawn({ cmd: ["harbor", "run", "--config", cfgPath], env: { ...process.env, OPENCODE_GO_API_KEY: key }, stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;

  await copySanitized(jobsDir, repoOut, key);
  await fs.chmod(cfgPath, 0o600);
  process.exit(code ?? 0);
}

/**
 * Scrub the apiKey out of EVERY file in a dir, in place (config.json, logs,
 * any artifact). Leaves the key nowhere on disk except the auth source, so an
 * accidental `harbor upload` or a stray copy of the job dir cannot leak it.
 */
async function scrubKeyInPlace(dir: string, key: string): Promise<number> {
  let scrubbed = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        const t = await fs.readFile(p, "utf8");
        if (t.includes(key)) {
          await fs.writeFile(p, t.split(key).join("REDACTED"));
          scrubbed++;
        }
      } catch {}
    }
  }
  return scrubbed;
}

/** Evidence worth keeping for someone reading the repo: verdict, agent
 *  behavior, and verifier proof. Everything else is harbor/openocode internals. */
const KEEP_GLOB: RegExp[] = [
  /result\.json$/, // trial + job verdicts (pass/fail, tokens, cost — includes the reward)
  /agent\/opencode\.txt$/, // raw agent transcript
  /agent\/trajectory\.json$/, // structured ATIF trajectory (metrics) — richest format
  /verifier\/ctrf\.json$/, // structured test results
];

/** Keep only evidence; drop harbor internals and the resolved config (key lives there pre-scrub). */
function shouldKeep(rel: string): boolean {
  if (path.basename(rel) === "config.json") return false;
  if (/xdg-data|xdg-state|snapshot|node_modules/.test(rel)) return false;
  return KEEP_GLOB.some((re) => re.test(rel));
}

/** Normalize harbor trial dirs (crack-7z-hash__Ab12Cd) to the plain task name. */
function normalizeRel(rel: string): string {
  return rel.replace(/([^/]+)__[A-Za-z0-9]+(\/|$)/, "$1$2");
}

/**
 * Copy harbor job evidence into the repo. The job dir is scrubbed in place
 * first (the apiKey in config.json -> REDACTED), so nothing copied carries the
 * key; a paranoid guard then fails loudly if the key is found in the repo.
 */
export async function copySanitized(jobsDir: string, repoOut: string, key: string): Promise<void> {
  const scrubbed = await scrubKeyInPlace(jobsDir, key);
  const jobsRoot = await fs.readdir(jobsDir).catch(() => []);
  if (!jobsRoot.length) return;
  let copied = 0;
  const stack: string[] = jobsRoot.map((f) => path.join(jobsDir, f));
  while (stack.length) {
    const src = stack.pop()!;
    const rel = path.relative(jobsDir, src);
    const st = await fs.stat(src).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const children = await fs.readdir(src).catch(() => []);
      for (const c of children) stack.push(path.join(src, c));
      continue;
    }
    if (!shouldKeep(rel)) continue;
    const dst = path.join(repoOut, normalizeRel(rel));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    copied++;
  }
  const leak = await findInRepo(repoOut, key);
  if (leak.length) {
    throw new Error(`SECURITY: apiKey leaked into ${repoOut}: ${leak.join(", ")}`);
  }
  console.log(`[harbor] scrubbed ${scrubbed} files in-place; copied ${copied} evidence files -> ${repoOut} (apiKey REDACTED)`);
}

async function findInRepo(repoOut: string, key: string): Promise<string[]> {
  const hits: string[] = [];
  const stack = [repoOut];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          const t = await fs.readFile(p, "utf8");
          if (t.includes(key)) hits.push(path.relative(repoOut, p));
        } catch {}
      }
    }
  }
  return hits;
}

if (import.meta.main) await main(process.argv.slice(2));
