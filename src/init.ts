import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// Agent compatibility matrix — mirrors proof's rule table. Directories follow
// each agent's documented skill convention; copilot and antigravity use the
// Agent Skills open standard location (~/.agents/skills).
const TARGETS = [
  { name: "opencode", home: "~/.config/opencode/skills", project: ".opencode/skills" },
  { name: "claude-code", home: "~/.claude/skills", project: ".claude/skills" },
  { name: "codex", home: "~/.codex/skills", project: ".codex/skills" },
  { name: "cursor", home: "~/.cursor/skills", project: ".cursor/skills" },
  { name: "copilot", home: "~/.agents/skills", project: ".agents/skills" },
  { name: "antigravity", home: "~/.agents/skills", project: ".agents/skills" },
  { name: "pi", home: "~/.pi/agent/skills", project: ".pi/skills" },
];

type Status = "installed" | "up-to-date" | "updated" | "conflict" | "agent-miss" | "unselected" | "error";

export interface InitResult {
  agent: string;
  what: string; // skill | hook-user | hook-agent | hooks-config
  dir: string;
  status: Status;
  note?: string;
}

export interface InitOptions {
  project: boolean;
  repo: string; // git root for project scope
  force: boolean;
  dryRun: boolean;
  only: string[]; // agent names; empty = all
  hooks: boolean; // also install hook adapters (explicit opt-in)
}

const SKILL_DIR = path.join(import.meta.dir, "..", "skill");

function resolveAgent(t: (typeof TARGETS)[number], opts: InitOptions): string {
  const base = opts.project ? opts.repo : homedir();
  const rel = (opts.project ? t.project : t.home).replace("~", "");
  return path.join(base, rel);
}

export function agentPaths(opts: InitOptions): string[] {
  return TARGETS.map((t) => resolveAgent(t, opts));
}

async function fileEq(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.readFile(a)).equals(await fs.readFile(b));
  } catch {
    return false;
  }
}

/** Install the host-neutral context skill into each selected agent dir. */
export async function init(opts: InitOptions): Promise<InitResult[]> {
  const out: InitResult[] = [];
  const src = path.join(SKILL_DIR, "SKILL.md");
  const agents = opts.only.length ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;

  for (const t of agents) {
    const dir = resolveAgent(t, opts);
    if (!opts.project && !(await exists(dir))) {
      out.push({ agent: t.name, what: "skill", dir, status: "agent-miss" });
      continue; // absent home-scope agent dir: report, never create silently
    }
    if (opts.project && !opts.dryRun) await fs.mkdir(dir, { recursive: true });

    const dstDir = path.join(dir, "context");
    if (!opts.dryRun) await fs.mkdir(dstDir, { recursive: true });
    const dst = path.join(dstDir, "SKILL.md");
    const same = await fileEq(src, dst);
    if (same) {
      out.push({ agent: t.name, what: "skill", dir: dstDir, status: "up-to-date" });
    } else if (await exists(dst)) {
      if (!opts.force) {
        out.push({ agent: t.name, what: "skill", dir: dstDir, status: "conflict", note: "use --force to overwrite" });
      } else {
        if (!opts.dryRun) await fs.copyFile(src, dst);
        out.push({ agent: t.name, what: "skill", dir: dstDir, status: "updated", note: opts.dryRun ? "dry-run" : undefined });
      }
    } else {
      if (!opts.dryRun) await fs.copyFile(src, dst);
      out.push({ agent: t.name, what: "skill", dir: dstDir, status: "installed", note: opts.dryRun ? "dry-run" : undefined });
    }
  }

  if (opts.hooks) {
    out.push(...(await installHooks(opts)));
  }
  return out;
}

// --hooks installs hook adapters for hosts that support them. Explicit opt-in
// (never silent). claude-code is the adapted host today; others are reported.
async function installHooks(opts: InitOptions): Promise<InitResult[]> {
  const out: InitResult[] = [];
  const repo = path.join(import.meta.dir, "..");
  const userHook = `bun run ${path.join(repo, "scripts", "hook-user.ts")}`;
  const agentHook = `bun run ${path.join(repo, "scripts", "hook-agent.ts")}`;

  for (const t of TARGETS) {
    if (opts.only.length && !opts.only.includes(t.name)) continue;
    if (t.name === "claude-code") {
      const settingsPath = opts.project
        ? path.join(opts.repo, ".claude", "settings.json")
        : path.join(homedir(), ".claude", "settings.json");
      const dir = path.dirname(settingsPath);
      if (!opts.project && !(await exists(dir))) {
        out.push({ agent: t.name, what: "hooks-config", dir, status: "agent-miss" });
        continue;
      }
      await fs.mkdir(dir, { recursive: true });
      let cfg: any = {};
      try {
        cfg = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      } catch {}
      const hooks = cfg.hooks ?? {};
      if (hooks.UserPromptSubmit || hooks.Stop) {
        out.push({ agent: t.name, what: "hooks-config", dir: settingsPath, status: "conflict", note: "existing hooks; use --force to overwrite" });
        if (!opts.force || opts.dryRun) continue;
      }
      if (opts.dryRun) {
        out.push({ agent: t.name, what: "hooks-config", dir: settingsPath, status: "updated", note: "dry-run" });
        continue;
      }
      hooks.UserPromptSubmit = userHook;
      hooks.Stop = agentHook;
      cfg.hooks = hooks;
      await fs.writeFile(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
      out.push({ agent: t.name, what: "hooks-config", dir: settingsPath, status: "updated" });
      out.push({ agent: t.name, what: "hook-user", dir: userHook, status: "installed" });
      out.push({ agent: t.name, what: "hook-agent", dir: agentHook, status: "installed" });
    } else {
      out.push({ agent: t.name, what: "hooks-config", dir: "", status: "unselected", note: "hook wiring not shipped for this host yet" });
    }
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
