import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { init } from "../src/init";

describe("context init", () => {
  test("installs the skill into project scope, idempotently", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-test-" + Date.now());
    await fs.mkdir(repo, { recursive: true });

    const opts = { project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: false };
    const r1 = await init(opts);
    const installed = r1.find((r) => r.what === "skill");
    expect(installed?.status).toBe("installed");
    expect(installed?.dir).toContain(".opencode/skills/context");

    const dst = path.join(repo, ".opencode", "skills", "context", "SKILL.md");
    const content = await fs.readFile(dst, "utf8");
    expect(content).toContain("context observe");

    const r2 = await init(opts);
    expect(r2.find((r) => r.what === "skill")?.status).toBe("up-to-date");

    // conflict: modify installed copy, no force -> conflict; force -> updated
    await fs.writeFile(dst, "# user-modified\n");
    expect((await init(opts)).find((r) => r.what === "skill")?.status).toBe("conflict");
    expect((await init({ ...opts, force: true })).find((r) => r.what === "skill")?.status).toBe("updated");

    await fs.rm(repo, { recursive: true, force: true });
  });

  test("dry-run writes nothing", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-dry-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: true, only: ["opencode"], hooks: false });
    expect(r.find((x) => x.what === "skill")?.note).toBe("dry-run");
    const dir = path.join(repo, ".opencode", "skills", "context");
    await expect(fs.access(dir)).rejects.toThrow();
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("hooks: claude-code settings.json gets the adapters, idempotently", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-hooks-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["claude-code"], hooks: true });
    const cfg = r.find((x) => x.what === "hooks-config");
    expect(cfg?.status).toBe("created");
    expect(cfg?.dir).toContain(".claude/settings.json");
    const settings = JSON.parse(await fs.readFile(cfg!.dir, "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook-user");
    // no Stop/agent hook: the session savings live in the statusline now
    expect(settings.hooks.Stop).toBeUndefined();
    // statusline + post-edit blast-radius wiring
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("statusline");
    expect(settings.subagentStatusLine.command).toContain("statusline");
    const postEdit = settings.hooks.PostToolUse[0];
    expect(postEdit.matcher).toBe("Write|Edit|MultiEdit");
    expect(postEdit.hooks[0].command).toContain("hook-edit");
    // foreign hooks preserved + re-init reports unchanged (idempotent merge)
    const rerun = await init({ project: true, repo, force: false, dryRun: false, only: ["claude-code"], hooks: true });
    expect(rerun.find((x) => x.what === "hooks-config")?.status).toBe("unchanged");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("hooks: codex hooks.json gets PostToolUse blast radius with apply_patch matcher", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-codex-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["codex"], hooks: true });
    const cfg = r.find((x) => x.what === "hooks-config");
    expect(cfg?.status).toBe("created");
    expect(cfg?.dir).toContain(".codex/hooks.json");
    const hooks = JSON.parse(await fs.readFile(cfg!.dir, "utf8"));
    expect(hooks.hooks.SessionStart[0].matcher).toBe("startup|resume|compact");
    expect(hooks.hooks.PostToolUse[0].matcher).toBe("apply_patch|Edit|Write");
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain("hook-edit");
    // no Stop/agent hook on codex either
    expect(hooks.hooks.Stop).toBeUndefined();
    // codex timeout unit is seconds
    expect(hooks.hooks.PostToolUse[0].hooks[0].timeout).toBe(10);
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("hooks: opencode plugin covers compaction + post-edit blast radius", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-oc-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: true });
    const cfg = r.find((x) => x.what === "hooks-config");
    expect(cfg?.status).toBe("installed");
    expect(cfg?.dir).toContain(".opencode/plugins/context.ts");
    const plugin = await fs.readFile(cfg!.dir, "utf8");
    expect(plugin).toContain("experimental.session.compacting");
    expect(plugin).toContain("tool.execute.after");
    expect(plugin).toContain("apply_patch");
    expect(plugin).toContain("hook-edit --text");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("hooks: hosts without wiring report unselected", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-hooks-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["cursor"], hooks: true });
    expect(r.find((x) => x.what === "hooks-config")?.status).toBe("unselected");
    const oc = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: true });
    expect(oc.find((x) => x.what === "hooks-config")?.status).toBe("installed");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("instructions: AGENTS.md line for hook-less hosts, idempotent, claude/codex skipped", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-inst-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode", "pi", "claude-code"], hooks: false });
    const inst = r.filter((x) => x.what === "instructions");
    expect(inst.map((x) => x.agent).sort()).toEqual(["opencode", "pi"]);
    // shared repo AGENTS.md: first agent created it, the next wrote the same block
    expect(inst.map((x) => x.status).sort()).toEqual(["created", "unchanged"]);
    const agentsMd = await fs.readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("<!-- context:start -->");
    expect(agentsMd).toContain("context observe");
    expect(agentsMd).toContain("<!-- context:end -->");
    // claude-code never touches CLAUDE.md
    await expect(fs.access(path.join(repo, ".claude", "CLAUDE.md"))).rejects.toThrow();
    // idempotent: rerun reports unchanged, no duplicate block
    const r2 = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode", "pi"], hooks: false });
    expect(r2.filter((x) => x.what === "instructions").every((x) => x.status === "unchanged")).toBe(true);
    const again = await fs.readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(again.match(/context:start/g)?.length).toBe(1);
    // foreign content preserved, block replaced in place when the line drifts
    await fs.writeFile(path.join(repo, "AGENTS.md"), "my rules\n" + agentsMd.replace("context observe", "context map") + "tail\n");
    const r3 = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: false });
    expect(r3.find((x) => x.what === "instructions")?.status).toBe("updated");
    const final = await fs.readFile(path.join(repo, "AGENTS.md"), "utf8");
    expect(final.startsWith("my rules\n")).toBe(true);
    expect(final.endsWith("tail\n")).toBe(true);
    expect(final).toContain("context observe");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("instructions: --no-instructions opt-out and dry-run", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-inst-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: true, only: ["opencode"], hooks: false });
    expect(r.find((x) => x.what === "instructions")?.status).toBe("created");
    expect(r.find((x) => x.what === "instructions")?.note).toBe("dry-run");
    await expect(fs.access(path.join(repo, "AGENTS.md"))).rejects.toThrow();
    const off = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: false, instructions: false });
    expect(off.find((x) => x.what === "instructions")).toBeUndefined();
    await fs.rm(repo, { recursive: true, force: true });
  });
});
