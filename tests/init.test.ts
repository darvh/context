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
    expect(content).toContain("context prepare");

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

  test("hooks: claude-code settings.json gets the adapters", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-hooks-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["claude-code"], hooks: true });
    const cfg = r.find((x) => x.what === "hooks-config");
    expect(cfg?.status).toBe("updated");
    expect(cfg?.dir).toContain(".claude/settings.json");
    const settings = JSON.parse(await fs.readFile(cfg!.dir, "utf8"));
    expect(settings.hooks.UserPromptSubmit).toContain("hook-user.ts");
    expect(settings.hooks.Stop).toContain("hook-agent.ts");
    await fs.rm(repo, { recursive: true, force: true });
  });

  test("hooks: hosts without wiring report unselected", async () => {
    const repo = path.join(import.meta.dir, "..", "var", "init-hooks-" + Date.now());
    await fs.mkdir(repo, { recursive: true });
    const r = await init({ project: true, repo, force: false, dryRun: false, only: ["opencode"], hooks: true });
    expect(r.find((x) => x.what === "hooks-config")?.status).toBe("unselected");
    await fs.rm(repo, { recursive: true, force: true });
  });
});
