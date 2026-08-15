import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = path.join(import.meta.dir, "..");
const INSTALL = path.join(REPO, "install.sh");
const MK_LAUNCHER = path.join(REPO, "scripts", "build", "mk-launcher.sh");

// project dirs must live OUTSIDE any git repo, or findRoot() resolves them to
// the enclosing repository and init installs there instead of the temp project
function projDir(): string {
  return path.join(tmpdir(), "ctx-proj-" + Date.now() + "-" + Math.random().toString(36).slice(2));
}

describe("install.sh", () => {
  test("global dry-run prints plan and exits 0", async () => {
    const { code, out } = await run(["bash", INSTALL, "--dry-run"], REPO);
    expect(code).toBe(0);
    expect(out).toContain("context install (scope: global");
  });

  test("local dry-run from a project dir prints project scope and exits 0", async () => {
    const proj = projDir();
    await fs.mkdir(proj, { recursive: true });
    const { code, out } = await run(["bash", INSTALL, "--local", "--dry-run", "--targets", "pi"], proj);
    expect(code).toBe(0);
    expect(out).toContain("scope: local");
    await fs.rm(proj, { recursive: true, force: true });
  });

  test("local install is user-scope only: skill + hooks land in HOME, never the project", async () => {
    const proj = projDir();
    const home = path.join(tmpdir(), "ctx-home-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fs.mkdir(proj, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const { code, out } = await run(["bash", INSTALL, "--local", "--targets", "pi"], proj, home);
    expect(code).toBe(0);
    expect(out).toContain("pi");
    // user scope: skill in $HOME, never in the project dir
    const skill = path.join(home, ".agents", "skills", "context", "SKILL.md");
    expect(existsSync(skill)).toBe(true);
    expect(await fs.readFile(skill, "utf8")).toContain("context observe");
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    expect(existsSync(path.join(proj, ".opencode"))).toBe(false);
    await fs.rm(proj, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("hooks install by default; --no-hooks opts out", async () => {
    const proj = projDir();
    const home = path.join(tmpdir(), "ctx-home-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fs.mkdir(proj, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await run(["bash", INSTALL, "--local", "--targets", "claude-code,opencode"], proj, home);
    expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(path.join(home, ".config", "opencode", "plugins", "context.ts"))).toBe(true);
    await fs.rm(proj, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
});

async function run(cmd: string[], cwd: string, home?: string): Promise<{ code: number; out: string; err: string }> {
  const env = { ...Bun.env, HOME: home ?? Bun.env.HOME, PATH: `/usr/local/bin:/opt/homebrew/bin:${Bun.env.PATH}` };
  const p = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err };
}

describe("installer launcher", () => {
  test("passes through a healthy compiled binary exit code", async () => {
    const root = path.join(REPO, "var", "launch-" + Date.now());
    const bin = path.join(root, "bin");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "context"), "#!/usr/bin/env bash\necho BINARY-RAN\nexit 0\n", { mode: 0o755 });
    await run(["bash", MK_LAUNCHER, root, bin], REPO);
    const { code, out } = await run([path.join(bin, "context")], REPO);
    expect(code).toBe(0);
    expect(out.trim()).toBe("BINARY-RAN");
    await fs.rm(root, { recursive: true, force: true });
  });

  test("falls back to the Bun source entrypoint when the binary cannot execute", async () => {
    const root = path.join(REPO, "var", "launch-" + Date.now());
    const bin = path.join(root, "bin");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "context"), "#!/usr/bin/env bash\nexit 127\n", { mode: 0o755 });
    await fs.writeFile(path.join(root, "src", "cli.ts"), "console.log('SOURCE-ENTRYPOINT-RAN');\n");
    await run(["bash", MK_LAUNCHER, root, bin], REPO);
    const { code, out, err } = await run([path.join(bin, "context"), "--help"], REPO);
    expect(code).toBe(0);
    expect(out).toContain("SOURCE-ENTRYPOINT-RAN");
    expect(err).toContain("falling back to source");
    await fs.rm(root, { recursive: true, force: true });
  });

  test("local mode: source-first even when a stale dist is runnable", async () => {
    const root = path.join(REPO, "var", "launch-" + Date.now());
    const bin = path.join(root, "bin");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "context"), "#!/usr/bin/env bash\necho STALE-BINARY\n", { mode: 0o755 });
    await fs.writeFile(path.join(root, "src", "cli.ts"), "console.log('CHECKOUT-SOURCE-RAN');\n");
    await run(["bash", MK_LAUNCHER, root, bin, "local"], REPO);
    const { code, out } = await run([path.join(bin, "context")], REPO);
    expect(code).toBe(0);
    expect(out).toContain("CHECKOUT-SOURCE-RAN");
    expect(out).not.toContain("STALE-BINARY");
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("--targets validation", () => {
  test("unknown agent name fails with a clear error", async () => {
    const proj = projDir();
    await fs.mkdir(proj, { recursive: true });
    const { code, err } = await run(["bun", "run", "src/cli.ts", "init", "--project", "--root", proj, "--targets", "bogus"], REPO);
    expect(code).toBe(1);
    expect(err).toContain("unknown --targets: bogus");
    await fs.rm(proj, { recursive: true, force: true });
  });

  test("known target passes", async () => {
    const proj = projDir();
    await fs.mkdir(proj, { recursive: true });
    const { code } = await run(["bun", "run", "src/cli.ts", "init", "--project", "--root", proj, "--targets", "opencode"], REPO);
    expect(code).toBe(0);
    await fs.rm(proj, { recursive: true, force: true });
  });
});
