/** Working-tree changes: staged + unstaged + untracked, repo-relative. */
export async function changedFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const p = Bun.spawn({
      cmd: ["git", "status", "--porcelain", "--untracked-files=all"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(p.stdout).text();
    await p.exited;
    for (const line of text.split("\n")) {
      if (!line || line.length < 4) continue;
      const f = line.slice(3).trim();
      if (f) out.add(f.replace(/^"?/, "").replace(/"?$/, ""));
    }
  } catch {}
  return out;
}
