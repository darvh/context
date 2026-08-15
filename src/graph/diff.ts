/** Git output helper: fails open (no git binary -> empty string). */
async function gitOut(root: string, cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn({ cmd: ["git", ...cmd], cwd: root, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text;
  } catch {
    return "";
  }
}

/** Working-tree changes: staged + unstaged + untracked, repo-relative. */
export async function changedFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const text = await gitOut(root, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of text.split("\n")) {
    if (!line || line.length < 4) continue;
    const raw = line.slice(3).trim();
    // porcelain renames: `R  old -> new` — both sides are working-tree state
    const parts = line.startsWith("R") ? raw.split(" -> ") : [raw];
    for (let f of parts) {
      f = f.replace(/^"?/, "").replace(/"?$/, "");
      if (f) out.add(f);
    }
  }
  return out;
}

/** Historical co-change pairs from the last N commits: "fileA\0fileB" ->
 *  commit count. Files that changed together in the past are the ownership /
 *  "why did this change?" lane — consulted only for explicit history intent. */
export async function coChangedFiles(root: string, commits = 20, maxPairs = 80): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const text = await gitOut(root, ["log", `-n${commits}`, "--name-only", "--pretty=format:%x00"]);
  for (const block of text.split("\0")) {
    const files = block.split("\n").filter((f) => f.trim() && !f.includes(" -> ")).slice(0, 12);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = files[i] < files[j] ? `${files[i]}\0${files[j]}` : `${files[j]}\0${files[i]}`;
        out.set(key, (out.get(key) ?? 0) + 1);
        if (out.size >= maxPairs) return out;
      }
    }
  }
  return out;
}
