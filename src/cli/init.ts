import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

// Agent compatibility matrix — mirrors proof's rule table. Directories follow
// each agent's documented skill convention; copilot and antigravity use the
// Agent Skills open standard location (~/.agents/skills). `probe`/`bin` are
// the presence heuristics installer mode uses: install only for agents that
// actually exist on the machine, never invent agent dirs (the shared
// ~/.agents home makes dir presence alone ambiguous, so each agent also
// probes its own config dir).
const TARGETS = [
  { name: "opencode", home: "~/.config/opencode/skills", project: ".opencode/skills", probe: [".config/opencode"], bin: "opencode" },
  { name: "claude-code", home: "~/.claude/skills", project: ".claude/skills", probe: [".claude"], bin: "claude" },
  { name: "codex", home: "~/.codex/skills", project: ".codex/skills", probe: [".codex"], bin: "codex" },
  { name: "cursor", home: "~/.cursor/skills", project: ".cursor/skills", probe: [".cursor"], bin: "cursor" },
  { name: "copilot", home: "~/.agents/skills", project: ".agents/skills", probe: [".config/github-copilot", ".vscode"], bin: "copilot" },
  { name: "antigravity", home: "~/.agents/skills", project: ".agents/skills", probe: [".antigravity"], bin: "antigravity" },
  { name: "pi", home: "~/.agents/skills", project: ".agents/skills", probe: [".pi"], bin: "pi" },
];

type Status = "installed" | "up-to-date" | "updated" | "conflict" | "agent-miss" | "unselected" | "error" | "unchanged" | "skipped-unparseable" | "created";

export const AGENT_NAMES = TARGETS.map((t) => t.name);

export interface InitResult {
  agent: string;
  what: string; // skill | hook-user | hook-edit | hooks-config | instructions
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
  /** install the one-line steering instruction into each host's global
   *  instructions file (default; --no-instructions opts out). Only hosts
   *  without a SessionStart hook get it (claude-code/codex inject the same
   *  nudge from the hook): ~40 tokens, always in context, zero runtime. */
  instructions?: boolean;
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
    path.join(import.meta.dir ?? "", "..", "..", "skill"),
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
    path.join(import.meta.dir ?? "", "..", "..", "scripts", "hooks"),
    path.join(exe, "..", "scripts", "hooks"),
    path.join(exe, "scripts", "hooks"),
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
// `hook-session`, `hook-edit`, and `statusline` subcommands, so
// hosts spawn the binary itself and no scripts/ sibling directory is needed.
// Source runs use the checkout scripts via bun.
async function hookCommands(): Promise<{ user: string; session: string; edit: string; statusline: string }> {
  const standalone = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
  if (standalone) {
    return {
      user: `"${process.execPath}" hook-user`,
      session: `"${process.execPath}" hook-session`,
      edit: `"${process.execPath}" hook-edit`,
      statusline: `"${process.execPath}" statusline`,
    };
  }
  const scripts = await scriptsDir();
  return {
    user: `bun run ${path.join(scripts, "hook-user.ts")}`,
    session: `bun run ${path.join(scripts, "hook-session.ts")}`,
    edit: `bun run ${path.join(scripts, "hook-edit.ts")}`,
    statusline: `bun run ${path.join(scripts, "statusline.ts")}`,
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
  presence.clear(); // probes are per-run: a PATH change between inits must be seen
  const src = path.join(await skillDir(), "SKILL.md");
  validateOnly(opts.only);
  const agents = opts.only.length ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;

  for (const t of agents) {
    const dir = resolveAgent(t, opts);
    if (!opts.project && !(opts.create ? await agentPresent(t) : await exists(dir))) {
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
  if (opts.instructions !== false) {
    out.push(...(await installInstructions(opts)));
  }
  return out;
}

// --no-hooks is the opt-out; hooks install by default for hosts that support
// them (never silently — each host gets an explicit config entry).
//
// Hook wiring: per-event idempotent merge. Foreign
// hook entries in an event are preserved, our own entries are replaced (so
// re-init re-points instead of stacking), nothing is written when the file is
// byte-identical, and unparseable host configs are skipped — never clobbered.
const OUR_MARKERS = ["hook-user", "hook-session", "hook-edit"];
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

/** Apply desired hook groups to a config with the idempotent merge. The hooks
 *  object is rebuilt in canonical order — foreign events first (file order),
 *  then our managed events in a fixed order — so re-init always writes the
 *  byte-identical file (a plain in-place merge drifts because JSON key order
 *  follows first insertion). Stale groups of ours in events we no longer
 *  manage (e.g. a removed hook adapter) are dropped, never preserved. */
function applyHookGroups(cfg: any, groups: { event: string; command: string; timeout: number; matcher?: string }[]): void {
  const existing = cfg.hooks ?? {};
  const managed = new Set(groups.map((g) => g.event));
  const next: any = {};
  for (const ev of Object.keys(existing)) {
    if (managed.has(ev)) continue;
    const foreign = (Array.isArray(existing[ev]) ? existing[ev] : []).filter((e) => !isOurs(e));
    if (foreign.length) next[ev] = foreign;
  }
  for (const g of groups) {
    next[g.event] = mergeHookEvent(existing[g.event], hookGroup(g.command, g.timeout, g.matcher));
  }
  cfg.hooks = next;
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
  const { user: userHook, session: sessionHook, edit: editHook, statusline: statuslineHook } = await hookCommands();

  for (const t of TARGETS) {
    if (opts.only.length && !opts.only.includes(t.name)) continue;
    if (opts.create && !(await agentPresent(t))) {
      out.push({ agent: t.name, what: "hooks-config", dir: "", status: "agent-miss", note: "agent not installed" });
      continue;
    }
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
        { event: "PostToolUse", command: editHook, timeout: 10, matcher: "Write|Edit|MultiEdit" },
      ]);
      // live statusline (graph size, stale badge, session token savings) —
      // Claude Code is the only supported host with a statusLine channel
      cfg.statusLine = { type: "command", command: statuslineHook };
      cfg.subagentStatusLine = { type: "command", command: statuslineHook };
      // headless/subagent runs deny Bash by default; an allowlist entry lets
      // the skill's `context` calls run without a permission prompt
      const allow = Array.isArray(cfg.permissions?.allow) ? [...cfg.permissions.allow] : [];
      for (const entry of ["Bash(context:*)", "Bash(context:*) --json*"]) {
        if (!allow.includes(entry)) allow.push(entry);
      }
      cfg.permissions = { ...(cfg.permissions ?? {}), allow };
      await writeJsonIfChanged(t.name, settingsPath, cfg, existed, out, opts.dryRun);
      out.push({ agent: t.name, what: "hook-user", dir: userHook, status: "installed" });
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
  const EDIT_TOOLS = ["edit", "write", "apply_patch"];
  return {
    event: async ({ event }) => {
      try {
        const msg = event?.message ?? event?.data?.message;
        const text = msg?.text ?? msg?.content ?? (typeof msg === "string" ? msg : "");
        if (Array.isArray(text)) text.forEach(capture);
        else capture(text);
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      try {
        const tool = String(input?.tool ?? "");
        if (!EDIT_TOOLS.includes(tool) || !directory) return;
        const args = output?.args ?? {};
        // opencode: edit/write carry filePath; apply_patch carries marker lines
        // in patchText (docs: check "apply_patch", not "patch")
        let file = args.filePath ?? args.path ?? args.file_path ?? null;
        if (!file && tool === "apply_patch" && args.patchText && typeof args.patchText === "string") {
          file = args.patchText.match(/^\\*\\*\\*\\s+(?:Add|Update)\\s+File:\\s+(.+)$/m)?.[1] ?? null;
        }
        if (!file) return;
        const br = await $\`context hook-edit --text\`.input(JSON.stringify({ file_path: file, cwd: directory })).text();
        const txt = br?.trim?.();
        if (txt) output.output = output.output ? output.output + "\\n\\n" + txt : txt;
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
      // startup, resume, and compaction; PostToolUse fires on edits (apply_patch)
      applyHookGroups(cfg, [
        { event: "SessionStart", command: sessionHook, timeout: 10, matcher: "startup|resume|compact" },
        { event: "UserPromptSubmit", command: userHook, timeout: 15 },
        { event: "PostToolUse", command: editHook, timeout: 10, matcher: "apply_patch|Edit|Write" },
      ]);
      await writeJsonIfChanged(t.name, hooksPath, cfg, existed, out, opts.dryRun);
      out.push({ agent: t.name, what: "hook-user", dir: userHook, status: "installed" });
    } else {
      out.push({ agent: t.name, what: "hooks-config", dir: "", status: "unselected", note: "hook wiring not shipped for this host yet" });
    }
  }
  return out;
}

// --no-instructions is the opt-out; the steering line installs by default.
//
// Only for hosts WITHOUT a session-start hook (claude-code + codex inject
// the same directive from SessionStart, so a static line would be pure
// duplication). Home scope exists ONLY where the host natively reads a global
// instructions file: opencode reads ~/.config/opencode/AGENTS.md (falls back
// to ~/.claude/CLAUDE.md when absent). cursor/copilot/antigravity/pi read
// AGENTS.md at the repo root only (cursor documents project + subdirectory
// AGENTS.md; its global rules are UI-managed), so they get project scope and
// no home file — a global write would be a native no-op.
const INSTRUCTIONS_FILES: Record<string, { home?: string; project: string }> = {
  opencode: { home: "AGENTS.md", project: "AGENTS.md" },
  antigravity: { project: "AGENTS.md" },
  pi: { project: "AGENTS.md" },
  cursor: { project: "AGENTS.md" },
  copilot: { project: "AGENTS.md" },
};

const INSTRUCTION_START = "<!-- context:start -->";
const INSTRUCTION_END = "<!-- context:end -->";

// One line, ~50 tokens: the always-in-context nudge. Full command reference
// lives in the skill (loaded on demand) and the SessionStart hook text.
const INSTRUCTION_LINE =
  "[context] MANDATORY before grepping, globbing, or reading files to understand this repo: run `context observe \"<task>\"` once — task-relevant " +
  "dirs/files/symbols with exact file:line (`context map`/`follow`/`impact`/`expand` drill-down; one call answers most tasks; skip for one-file edits). " +
  "Searching first, observing after, is the anti-pattern. Navigation only — read the source for evidence.";
const INSTRUCTION_BLOCK = `${INSTRUCTION_START}\n${INSTRUCTION_LINE}\n${INSTRUCTION_END}`;

/** Marker-block upsert: replace our block in place, never touch foreign text. */
function applyInstructionBlock(before: string): string {
  if (before.includes(INSTRUCTION_START)) {
    return before.replace(new RegExp(`${INSTRUCTION_START}[\\s\\S]*?${INSTRUCTION_END}`), INSTRUCTION_BLOCK);
  }
  return `${before.trimEnd()}\n\n${INSTRUCTION_BLOCK}\n`;
}

/** Install the steering line into each agent's instructions file. Home scope
 *  never creates absent agent dirs (same agent-miss rule as the skill);
 *  shared project files (repo AGENTS.md) are byte-idempotent across agents. */
async function installInstructions(opts: InitOptions): Promise<InitResult[]> {
  const out: InitResult[] = [];
  const agents = opts.only.length ? TARGETS.filter((t) => opts.only.includes(t.name)) : TARGETS;
  for (const t of agents) {
    const rel = INSTRUCTIONS_FILES[t.name];
    if (!rel) continue;
    const file = opts.project
      ? path.join(opts.repo, rel.project)
      : rel.home
        ? path.join(path.dirname(resolveAgent(t, opts)), rel.home)
        : "";
    if (!file) continue;
    const homeDir = path.dirname(file);
    if (!opts.project && !(opts.create ? await agentPresent(t) : await exists(homeDir))) {
      out.push({ agent: t.name, what: "instructions", dir: file, status: "agent-miss" });
      continue;
    }
    const existed = await exists(file);
    let before = existed ? await fs.readFile(file, "utf8").catch(() => "") : "";
    // AGENTS.md shadows CLAUDE.md (opencode: the fallback only applies when
    // AGENTS.md is absent), so a fresh file seeds from the existing CLAUDE.md
    // instead of silently dropping those instructions.
    if (before === "") {
      const claudeMd = opts.project ? path.join(opts.repo, "CLAUDE.md") : path.join(homedir(), ".claude", "CLAUDE.md");
      before = await fs.readFile(claudeMd, "utf8").catch(() => "");
    }
    const next = applyInstructionBlock(before);
    let status: Status;
    if (next === before) status = "unchanged";
    else if (opts.dryRun) status = existed ? "updated" : "created";
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, next);
      status = existed ? "updated" : "created";
    }
    out.push({ agent: t.name, what: "instructions", dir: file, status, note: opts.dryRun ? "dry-run" : undefined });
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

/** Presence probe, cached per init run: a PATH binary that answers
 *  `--version` proves a real agent CLI (a name collision like some unrelated
 *  `pi` won't pass). GUI-only installs have no CLI, so the config-dir probe
 *  stays as the fallback; the shared ~/.agents skills home never counts — it
 *  is created by this installer, not by the agent. */
const presence = new Map<string, boolean>();
async function agentPresent(t: (typeof TARGETS)[number]): Promise<boolean> {
  const hit = presence.get(t.name);
  if (hit !== undefined) return hit;
  let present = false;
  const p = t.bin ? await Bun.which(t.bin) : null;
  if (p) {
    const v = await execFile(p, ["--version"], { timeout: 2000 });
    present = v === null || v.killed === false;
  }
  if (!present) {
    for (const d of t.probe ?? []) {
      if (await exists(path.join(homedir(), d))) {
        present = true;
        break;
      }
    }
  }
  presence.set(t.name, present);
  return present;
}
