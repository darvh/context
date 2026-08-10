import type { Capsule } from "./assemble";

/** Compact human rendering. Deterministic. */
export function renderCapsule(c: Capsule): string {
  const lines: string[] = [];
  lines.push(`query: ${c.query}`);
  lines.push(`repo: ${c.root}`);
  if (c.gitHead) lines.push(`git_head: ${c.gitHead}`);
  lines.push(`working_tree: ${c.workingTree}`);
  lines.push(`budget: ${c.budgetTokens} tokens (used ~${c.tokensUsed}, estimated)`);

  if (c.files.length) {
    lines.push(`\npaths:`);
    for (const f of c.files) lines.push(`  - ${f}`);
  }
  if (c.entryPoints.length) {
    lines.push(`\nentry_points:`);
    for (const e of c.entryPoints) lines.push(`  - ${e}`);
  }

  lines.push(`\nhits:`);
  if (!c.hits.length) {
    lines.push(`  (none — no confident match; fall back to normal search)`);
  }
  for (const h of c.hits) {
    lines.push(`  - ${h.handle} ${h.kind} ${h.name}  ${h.file}:${h.line}`);
    if (h.sig) lines.push(`    sig: ${h.sig}`);
    if (h.reason.length) lines.push(`    reason: ${h.reason.join(", ")}`);
    lines.push(`    conf: ${h.conf}`);
  }

  if (c.unresolvedTerms.length) {
    lines.push(`\nunresolved_terms: ${c.unresolvedTerms.join(", ")}`);
  }
  if (c.truncated) lines.push(`truncated: true`);

  lines.push(`\nnext:`);
  for (const n of c.next) lines.push(`  - ${n}`);

  return lines.join("\n") + "\n";
}

export function capsuleToJson(c: Capsule): string {
  return JSON.stringify(c, null, 2);
}
