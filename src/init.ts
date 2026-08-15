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

type Status = "installed" | "up-to-date" | "updated" | "conflict" | "agent-miss" | "unselected" | "error" | "unchanged" | "skipped-unparseable" | "created";

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
//
// Hook wiring follows the graft pattern: per-event idempotent merge. Foreign
// hook entries in an event are preserved, our own entries are replaced (so
// re-init re-points instead of stacking), nothing is written when the file is
// byte-identical, and unparseable host configs are skipped — never clobbered.
const OUR_MARKERS = ["hook-user", "hook-agent", "hook-session"];
function isOurs(entry: unknown): boolean {
  return OUR_MARKERS.some((m) => JSON.stringify(entry).includes(m));
}

/** Merge one hook group into an event list: foreign entries first, ours last. */
function mergeHookEvent(existing: unknown, group: unknown): unknown[] {
  const prior = Array.isArray(existing) ? existing : [];
  return [...prior.filter((e) => !isOurs(e)), group];
}

/** One command hook group (matcher only where the host honors it). */
function hookGroup(command: string, timeout: number, matcher?: string): object {
  const handler = { type: "command", command, timeout };
  return matcher ? { matcher, hooks: [handler] } : { hooks: [handler] };
}

/** Apply desired hook groups to a config with the idempotent merge. */
function applyHookGroups(cfg: any, groups: { event: string; command: string; timeout: number; matcher?: string }[]): void {
  const hooks = cfg.hooks ?? {};
  for (const g of groups) hooks[g.event] = mergeHookEvent(hooks[g.event], hookGroup(g.command, g.timeout, g.matcher));
  cfg.hooks = hooks;
}

/** Load a hooks config file: null when the dir is absent (manual init never
 *  creates silently) or the file is unparseable (never clobber a broken
 *  config). */
async function loadHookFile(agent: string, opts: InitOptions, configPath: string, out: InitResult[]): Promise<{ cfg: any; existed: boolean } | null> {
  const dir = path.dirname(configPath);
  if (!opts.project && !opts.create && !(await exists(dir))) {
    out.push({ agent, what: "hooks-config", dir, status: "agent-miss" });
    return null;
  }
  await fs.mkdir(dir, { recursive: true });
  let cfg: any = null;
  let existed = false;
  try {
    cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    existed = true;
  } catch {}
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    if (existed) {
      out.push({ agent, what: "hooks-config", dir: configPath, status: "skipped-unparseable", note: "existing config is not a JSON object; left untouched" });
      return null;
    }
    cfg = {};
  }
  return { cfg, existed };
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
      const loaded = await loadHookFile(t.name, opts, settingsPath, out);
      if (!loaded) continue;
      const { cfg, existed } = loaded;
      // array form so each event carries a timeout (string form cannot)
      applyHookGroups(cfg, [
        { event: "SessionStart", command: sessionHook, timeout: 8 },
        { event: "UserPromptSubmit", command: userHook, timeout: 15 },
        { event: "Stop", command: agentHook, timeout: 8 },
      ]);
      // headless/subagent runs deny Bash by default; an allowlist entry lets
      // the skill's `context` calls run without a permission prompt
      const allow = Array.isArray(cfg.permissions?.allow) ? [...cfg.permissions.allow] : [];
      for (const entry of ["Bash(context:*)", "Bash(context:*) --json*"]) {
        if (!allow.includes(entry)) allow.push(entry);
      }
      cfg.permissions = { ...(cfg.permissions ?? {}), allow };
      await writeJsonIfChanged(t.name, settingsPath, cfg, existed, out, opts.dryRun);
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
      const before = await fs.readFile(pluginPath, "utf8").catch(() => "");
      if (before === plugin) {
        out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: "unchanged" });
        continue;
      }
      if (opts.dryRun) {
        out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: "updated", note: "dry-run" });
        continue;
      }
      await fs.writeFile(pluginPath, plugin);
      out.push({ agent: t.name, what: "hooks-config", dir: pluginPath, status: before ? "updated" : "installed" });
    } else if (t.name === "codex") {
      // codex supports UserPromptSubmit (prompt injection, same shape as
      // claude) and Stop (common output fields) via ~/.codex/hooks.json.
      const hooksPath = opts.project ? path.join(opts.repo, ".codex", "hooks.json") : path.join(homedir(), ".codex", "hooks.json");
      const loaded = await loadHookFile(t.name, opts, hooksPath, out);
      if (!loaded) continue;
      const { cfg, existed } = loaded;
      // matcher only where Codex honors it; SessionStart re-orients after
      // startup, resume, and compaction
      applyHookGroups(cfg, [
        { event: "SessionStart", command: sessionHook, timeout: 10, matcher: "startup|resume|compact" },
        { event: "UserPromptSubmit", command: userHook, timeout: 15 },
        { event: "Stop", command: agentHook, timeout: 10 },
      ]);
      await writeJsonIfChanged(t.name, hooksPath, cfg, existed, out, opts.dryRun);
      out.push({ agent: t.name, what: "hook-user", dir: userHook, status: "installed" });
      out.push({ agent: t.name, what: "hook-agent", dir: agentHook, status: "installed" });
    } else {
      out.push({ agent: t.name, what: "hooks-config", dir: "", status: "unselected", note: "hook wiring not shipped for this host yet" });
    }
  }
  return out;
}

/** Write a hooks config only when it changed; report updated/unchanged. */
async function writeJsonIfChanged(agent: string, configPath: string, cfg: any, existed: boolean, out: InitResult[], dryRun: boolean): Promise<void> {
  const before = await fs.readFile(configPath, "utf8").catch(() => "");
  const next = JSON.stringify(cfg, null, 2) + "\n";
  if (before === next) {
    out.push({ agent, what: "hooks-config", dir: configPath, status: "unchanged" });
    return;
  }
  if (dryRun) {
    out.push({ agent, what: "hooks-config", dir: configPath, status: "updated", note: "dry-run" });
    return;
  }
  await fs.writeFile(configPath, next);
  out.push({ agent, what: "hooks-config", dir: configPath, status: existed ? "updated" : "created" });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
