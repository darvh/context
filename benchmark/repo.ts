import { promises as fs } from "node:fs";
import path from "node:path";

export const isRemote = (spec: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(spec);

/**
 * Materialize the pinned repo state into a dest dir.
 * - remote URL -> clone at `revision` (exact pin)
 * - local git repo + revision -> clone from it and checkout
 * - plain dir -> copy as-is
 */
export async function copyRepo(repo: string, revision: string | undefined, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const localGit = !isRemote(repo) && (await fs.access(path.join(repo, ".git")).then(() => true).catch(() => false));

  if (isRemote(repo) || (revision && localGit)) {
    const src = isRemote(repo) ? repo : path.resolve(repo);
    const p = Bun.spawn({ cmd: ["git", "clone", "--quiet", src, dest], stdout: "pipe", stderr: "pipe" });
    const cerr = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) throw new Error(`clone failed: ${cerr}`);
    if (revision) {
      const co = Bun.spawn({ cmd: ["git", "-C", dest, "checkout", "--quiet", revision], stdout: "pipe", stderr: "pipe" });
      const coerr = await new Response(co.stderr).text();
      if ((await co.exited) !== 0) throw new Error(`checkout ${revision} failed: ${coerr}`);
    }
    return;
  }
  await fs.cp(repo, dest, { recursive: true });
}

export async function copyRepoAndPin(repoSpec: string, revision: string | undefined, dest: string, baseRoot: string): Promise<void> {
  const src = isRemote(repoSpec) ? repoSpec : path.resolve(baseRoot, repoSpec);
  await copyRepo(src, revision, dest);
}
