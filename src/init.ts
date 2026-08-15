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
  { name: "pi", home: "~/.agents/skills", project: ".agents/skills" },
];

type Status = "installed" | "up-to-date" | "updated" | "conflict" | "agent-miss" | "unselected" | "error";

export const AGENT_NAMES = TARGETS.map((t) => t.name);

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
  hooks: boolean; // install hook adapters (default; --no-hooks opts out)
  /** installer mode: create absent home-scope agent dirs instead of
   *  reporting agent-miss (manual `context init` never creates silently) */
  create?: boolean;
}

// Compiled binaries bundle src/ into $bunfs; skill/ is EMBEDDED via
// `--asset ./skill` (readable at import.meta.dir/skill). Source runs resolve
// it from the checkout. First real path wins.
async function skillDir(): Promise<string> {
  const exe = path.dirname(process.execPath);
  const candidates = [
    path.join(import.meta.dir ?? "", "skill"), // embedded (standalone)
    path.join(exe, "..", "skill"),
    path.join(exe, "skill"),
    path.join(import.meta.dir ?? "", "..", "skill"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "SKILL.md"));
      return c;
    } catch {}
  }
  return candidates[candidates.length - 1];
}

// Same resolution for the checkout scripts (source-mode hook commands).
async function scriptsDir(): Promise<string> {
  const exe = path.dirname(process.execPath);
  const candidates = [
    path.join(import.meta.dir ?? "", "..", "scripts"),
    path.join(exe, "..", "scripts"),
    path.join(exe, "scripts"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "hook-user.ts"));
      return c;
    } catch {}
  }
  return candidates[candidates.length - 1];
}

// Hook adapters are SELF-HOSTED: the compiled binary serves `hook-user`,
// `hook-agent`, and `hook-session` subcommands, so hosts spawn the binary
// itself and no scripts/ sibling directory is needed. Source runs use the
// checkout scripts via bun.
async function hookCommands(): Promise<{ user: string; agent: string; session: string }> {
  const standalone = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
  if (standalone) {
    return {
      user: `"${process.execPath}" hook-user`,
      agent: `"${process.execPath}" hook-agent`,
      session: `"${process.execPath}" hook-session`,
    };
  }
  const scripts = await scriptsDir();
  return {
    user: `bun run ${path.join(scripts, "hook-user.ts")}`,
    agent: `bun run ${path.join(scripts, "hook-agent.ts")}`,
    session: `bun run ${path.join(scripts, "hook-session.ts")}`,
  };
}

function resolveAgent(t: (typeof TARGETS)[number], opts: InitOptions): string {
  const base = opts.project ? opts.repo : homedir();
  const rel = (opts.project ? t.project : t.home).replace("~", "");
  return path.join(base, rel);
}

export function agentPaths(opts: InitOptions): string[] {
  const agents = opts.only.length ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;
  return agents.map((t) => resolveAgent(t, opts));
}

async function copyFile(src: string, dst: string): Promise<void> {
  // embedded (bunfs) sources cannot be copyFile'd: read then write
  const data = await fs.readFile(src);
  await fs.writeFile(dst, data);
}

async function fileEq(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.readFile(a)).equals(await fs.readFile(b));
  } catch {
    return false;
  }
}

/** Fail on unknown agent names so `--targets typo` never silently installs nothing. */
function validateOnly(only: string[]): void {
  const unknown = only.filter((n) => !AGENT_NAMES.includes(n));
  if (unknown.length) {
    throw new Error(`unknown agent target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (known: ${AGENT_NAMES.join(", ")})`);
  }
}

/** Install the host-neutral context skill into each selected agent dir. */
export async function init(opts: InitOptions): Promise<InitResult[]> {
  const out: InitResult[] = [];
  const src = path.join(await skillDir(), "SKILL.md");
  validateOnly(opts.only);
  const agents = opts.only.length ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;

  for (const t of agents) {
    const dir = resolveAgent(t, opts);
    if (!opts.project && !opts.create && !(await exists(dir))) {
      out.push({ agent: t.name, what: "skill", dir, status: "agent-miss" });
      continue; // absent home-scope agent dir: report, never create silently
    }
    if (!opts.dryRun) await fs.mkdir(dir, { recursive: true });

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
        if (!opts.dryRun) await copyFile(src, dst);
        out.push({ agent: t.name, what: "skill", dir: dstDir, status: "updated", note: opts.dryRun ? "dry-run" : undefined });
      }
    } else {
      if (!opts.dryRun) await copyFile(src, dst);
      out.push({ agent: t.name, what: "skill", dir: dstDir, status: "installed", note: opts.dryRun ? "dry-run" : undefined });
    }
  }

  if (opts.hooks) {
    out.push(...(await installHooks(opts)));
  }
  return out;
}

// --no-hooks is the opt-out; hooks install by default for hosts that support
// them (never silently — each host gets an explicit config entry).
/** Shared hooks-config prologue: resolve dir, agent-miss when absent
 *  (manual init never creates silently), mkdir, load, conflict-check.
 *  Returns null when the caller must skip writing. */
async function loadHooksConfig(agent: string, opts: InitOptions, configPath: string, out: InitResult[]): Promise<any | null> {
  const dir = path.dirname(configPath);
  if (!opts.project && !opts.create && !(await exists(dir))) {
    out.push({ agent, what: "hooks-config", dir, status: "agent-miss" });
    return null;
  }
  await fs.mkdir(dir, { recursive: true });
  let cfg: any = {};
  try {
    cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {}
  const hooks = cfg.hooks ?? {};
  if (hooks.SessionStart || hooks.UserPromptSubmit || hooks.Stop) {
    out.push({ agent, what: "hooks-config", dir: configPath, status: "conflict", note: "existing hooks; use --force to overwrite" });
    if (!opts.force || opts.dryRun) return null;
  }
  return cfg;
}

async function installHooks(opts: InitOptions): Promise<InitResult[]> {
  const out: InitResult[] = [];
  const { user: userHook, agent: agentHook, session: sessionHook } = await hookCommands();

  for (const t of TARGETS) {
    if (opts.only.length && !opts.only.includes(t.name)) continue;
    if (t.name === "claude-code") {
      const settingsPath = opts.project
        ? path.join(opts.repo, ".claude", "settings.json")
        : path.join(homedir(), ".claude", "settings.json");
      const cfg = await loadHooksConfig(t.name, opts, settingsPath, out);
      if (!cfg) continue;
      const hooks = cfg.hooks ?? {};
      if (opts.dryRun) {
        out.push({ agent: t.name, what: "hooks-config", dir: settingsPath, status: "updated", note: "dry-run" });
        continue;
      }
      hooks.SessionStart = sessionHook;
      hooks.UserPromptSubmit = userHook;
      hooks.Stop = agentHook;
      cfg.hooks = hooks;
      await fs.writeFile(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
      out.push({ agent: t.name, what: "hooks-config", dir: settingsPath, status: "updated" });
      out.push({ agent: t.name, what: "hook-user", dir: userHook, status: "installed" });
      out.push({ agent: t.name, what: "hook-agent", dir: agentHook, status: "installed" });
    } else if (t.name === "opencode") {
      // opencode has no prompt-injection hook; the compaction hook keeps the
      // context capsule alive across session compaction. Plugin file, not a
      // JSON entry. Defensive: unknown input shapes degrade to no-op.
      const pluginsDir = opts.project ? path.join(opts.repo, ".opencode", "plugins") : path.join(homedir(), ".config", "opencode", "plugins");
      const pluginPath = path.join(pluginsDir, "context.ts");
      const plugin = `export const ContextCompactionPlugin = async ({ directory, $ }) => {
  let lastTask = "";
  const capture = (text) => {
    if (text && text.trim().length >= 40) lastTask = text.trim();
  };
  return {
    event: async ({ event }) => {
      try {
        const msg = event?.message ?? event?.data?.message;
        const text = msg?.text ?? msg?.content ?? (typeof msg === "string" ? msg : "");
        if (Array.isArray(text)) text.forEach(capture);
        else capture(text);
      } catch {}
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        if (!lastTask || !directory) return;
        const cap = await $\`context observe \${lastTask} --budget 600 --json\`.text();
        const c = JSON.parse(cap);
        output.context.push(\`[context capsule — navigation only]
working_tree: \${c.workingTree ?? ""}
directories: \${(c.dirs ?? []).map((d) => d.path).join(", ")}
paths: \${(c.files ?? []).join(", ")}
hits: \${(c.hits ?? []).map((h) => \`\${h.name} \${h.file}:\${h.line}\`).join("; ")}
expand with: context expand \${c.hits?.[0]?.handle ?? ""}\`);
      } catch {}
    },
  };
};
`;
      await fs.mkdir(pluginsDir, { recursive: true });
      const existing = await fs.readFile(pluginPath, "utf8").catch(() => "");
      if (existing && existing !== plugin && !opts.force) {
        out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: "conflict", note: "existing plugin; use --force to overwrite" });
        continue;
      }
      if (opts.dryRun) {
        out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: "updated", note: "dry-run" });
        continue;
      }
      await fs.writeFile(pluginPath, plugin);
      out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: "installed" });
    } else if (t.name === "codex") {
      // codex supports UserPromptSubmit (prompt injection, same shape as
      // claude) and Stop (common output fields) via ~/.codex/hooks.json.
      const hooksPath = opts.project ? path.join(opts.repo, ".codex", "hooks.json") : path.join(homedir(), ".codex", "hooks.json");
      const cfg = await loadHooksConfig(t.name, opts, hooksPath, out);
      if (!cfg) continue;
      const hooks = cfg.hooks ?? {};
      if (hooks.SessionStart || hooks.UserPromptSubmit || hooks.Stop) {
        out.push({ agent: t.name, what: "hooks-config", dir: hooksPath, status: "conflict", note: "existing hooks; use --force to overwrite" });
        if (!opts.force || opts.dryRun) continue;
      }
      if (opts.dryRun) {
        out.push({ agent: t.name, what: "hooks-config", dir: hooksPath, status: "updated", note: "dry-run" });
        continue;
      }
      hooks.SessionStart = [{ hooks: [{ type: "command", command: sessionHook, timeout: 5 }] }];
      hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: userHook, timeout: 30 }] }];
      hooks.Stop = [{ hooks: [{ type: "command", command: agentHook, timeout: 5 }] }];
      cfg.hooks = hooks;
      await fs.writeFile(hooksPath, JSON.stringify(cfg, null, 2) + "\n");
      out.push({ agent: t.name, what: "hooks-config", dir: hooksPath, status: "updated" });
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
