import type { BuildResult } from "./build";
import { follow, renderFollow, resolveSymbol, type TrailStep } from "./follow";
import type { SymbolFact } from "./facts";

/** Neighborhood RepoMap: a small, relationship-centered textual map over one
 *  directory or one symbol, compiled from the cached graph per request. Not a
 *  second search index — bounded, grouped by file and role. */

const DIR_FILES_MAX = 12;
const FILE_SYMS_MAX = 5;
const SYM_EDGES_MAX = 12;

interface FileBlock {
  file: string;
  syms: SymbolFact[];
  calls: string[]; // "name -> target (via file:line)"
  testedBy: string[];
}

/** Local map of one directory: files, their important symbols, and what they
 *  call (1 hop, deduped, bounded). */
export function mapDir(b: BuildResult, dir: string): { blocks: FileBlock[]; truncated: boolean } {
  const prefix = dir.replace(/\/$/, "") + "/";
  const byFile = new Map<string, SymbolFact[]>();
  for (const s of b.graph.symbols) {
    if (s.kind === "import") continue;
    if (!(dir === "." ? !s.file.includes("/") : s.file.startsWith(prefix))) continue;
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  }
  const files = [...byFile.keys()].sort();
  const truncated = files.length > DIR_FILES_MAX;
  const blocks: FileBlock[] = [];
  for (const f of files.slice(0, DIR_FILES_MAX)) {
    const syms = byFile.get(f)!.sort((a, b) => a.nameLine - b.nameLine).slice(0, FILE_SYMS_MAX);
    const calls = new Set<string>();
    const testedBy = new Set<string>();
    for (const e of b.graph.edges) {
      if (e.from && byFile.get(f)?.some((s) => s.id === e.from)) {
        if (e.kind === "call" && e.to) calls.add(`${e.name} -> ${e.to.split("::")[1]} (${e.at})`);
        else if (e.kind === "test") testedBy.add(`${e.name} (${e.at})`);
      }
      if (calls.size + testedBy.size >= SYM_EDGES_MAX) break;
    }
    blocks.push({ file: f, syms, calls: [...calls].slice(0, SYM_EDGES_MAX), testedBy: [...testedBy].slice(0, SYM_EDGES_MAX) });
  }
  return { blocks, truncated };
}

/** Relationship-centered map of one symbol: one hop, grouped by role and file. */
export function mapSymbol(b: BuildResult, name: string): { out: string; truncated: boolean } {
  const r = follow(b, name, "all", 1);
  if (r.ambiguous || !r.symbol || !r.trails.length) return { out: renderFollow(r), truncated: false };
  const lines: string[] = [];
  lines.push(`map: ${r.symbol.name} (${r.symbol.kind}) ${r.symbol.file}:${r.symbol.nameLine}`);
  lines.push(`sig: ${r.symbol.sig}`);
  const byRole = new Map<string, TrailStep[]>();
  for (const t of r.trails) {
    const s = t.steps[1];
    const role = s!.edge === "test" ? "tests" : s!.edge === "call" || s!.edge === "ref" ? (s!.dir === "out" ? "callees" : "callers") : "relations";
    byRole.set(role, [...(byRole.get(role) ?? []), s!]);
  }
  const byFile = (xs: TrailStep[]) => [...new Map(xs.map((x) => [`${x.file}:${x.line}`, x])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const [role, xs] of byRole) {
    lines.push(`  ${role}: ${byFile(xs).slice(0, 6).map((x) => `${x.name} ${x.file}:${x.line}`).join(", ")}`);
  }
  return { out: lines.join("\n"), truncated: r.truncated };
}
