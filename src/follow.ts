import type { BuildResult } from "./build";
import type { Edge, SymbolFact } from "./facts";

/** Bounded directional graph traversal. Callers/callees/tests/inheritance by
 *  edge kind, with short trails (symbol -> ... -> target) instead of a global
 *  two-hop score. Deterministic: BFS in edge order, depth and count capped. */

export const EDGE_KINDS = ["call", "import", "inherit", "implement", "ref", "contain", "test"] as const;

interface TrailStep {
  id: string;
  name: string;
  file: string;
  line: number;
  via: string; // "file:line"
  edge: Edge["kind"] | "";
  dir: "out" | "in"; // walk direction: out = target, in = source of the edge
}

interface Trail {
  steps: TrailStep[]; // first step is the query symbol
}

export interface FollowResult {
  symbol?: SymbolFact;
  ambiguous?: boolean;
  candidates?: { id: string; file: string; line: number }[];
  edge: Edge["kind"] | "all";
  trails: Trail[];
  truncated: boolean;
}

const MAX_DEPTH = 3;
const MAX_TRAILS = 8;

function symbolAt(id: string, byId: Map<string, SymbolFact>): SymbolFact {
  return byId.get(id)!;
}

/** Resolve a bare name or qualified id to a symbol; ambiguous names yield candidates. */
function resolveSymbol(b: BuildResult, name: string): { sym?: SymbolFact; ambiguous?: boolean; candidates?: { id: string; file: string; line: number }[] } {
  const byId = new Map(b.graph.symbols.map((s) => [s.id, s]));
  const byName = new Map<string, SymbolFact[]>();
  for (const s of b.graph.symbols) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const q = byId.get(name);
  if (q) return { sym: q };
  const cands = byName.get(name);
  if (!cands) return {};
  if (cands.length > 1) return { ambiguous: true, candidates: cands.map((c) => ({ id: c.id, file: c.file, line: c.nameLine })) };
  return { sym: cands[0] };
}

export function follow(b: BuildResult, name: string, edge: string, depth = MAX_DEPTH): FollowResult {
  const byId = new Map(b.graph.symbols.map((s) => [s.id, s]));
  const kind = edge === "all" || edge === "" ? "all" : (edge as Edge["kind"]);
  const edgeKinds = kind === "all" ? new Set<string>(EDGE_KINDS) : new Set([kind]);

  const outbound = new Map<string, Edge[]>();
  const inbound = new Map<string, Edge[]>();
  for (const e of b.graph.edges) {
    if (!e.to || !edgeKinds.has(e.kind)) continue;
    outbound.set(e.from, [...(outbound.get(e.from) ?? []), e]);
    inbound.set(e.to, [...(inbound.get(e.to) ?? []), e]);
  }

  const resolved = resolveSymbol(b, name);
  if (!resolved.sym) {
    return { ambiguous: resolved.ambiguous, candidates: resolved.candidates, edge: kind, trails: [], truncated: false };
  }
  const start = resolved.sym;

  // BFS both directions from the start symbol; a trail is one walk
  // (caller-side edges reversed so every trail reads start -> ... -> end).
  const trails: Trail[] = [];
  const visited = new Set<string>([start.id]);
  const frontier: { id: string; via: string; edge: Edge["kind"]; dir: "out" | "in"; trail: TrailStep[] }[] = [
    { id: start.id, via: `${start.file}:${start.nameLine}`, edge: "" as Edge["kind"], dir: "out", trail: [{ id: start.id, name: start.name, file: start.file, line: start.nameLine, via: "", edge: "", dir: "out" }] },
  ];
  let truncated = false;
  let depthNow = 0;
  while (frontier.length && trails.length < MAX_TRAILS) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const forward = (outbound.get(f.id) ?? []).filter((e) => !visited.has(e.to));
      const backward = (inbound.get(f.id) ?? []).filter((e) => !visited.has(e.from));
      const edges = [...forward.map((e) => [e, "out"] as const), ...backward.map((e) => [e, "in"] as const)];
      if (!edges.length) continue;
      for (const [e, dir] of edges) {
        const nextId = f.id === e.from ? e.to : e.from;
        const s = symbolAt(nextId, byId);
        const t: TrailStep = { id: nextId, name: s.name, file: s.file, line: s.nameLine, via: e.at, edge: e.kind, dir };
        if (trails.length >= MAX_TRAILS) break;
        trails.push({ steps: [...f.trail, t] });
        if (depthNow < depth - 1) {
          visited.add(nextId);
          next.push({ id: nextId, via: e.at, edge: e.kind, dir, trail: [...f.trail, t] });
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
    depthNow++;
    if (depthNow >= depth && frontier.length) { truncated = true; break; }
  }
  if (frontier.length) truncated = true;

  trails.sort((a, b) => {
    const x = a.steps[a.steps.length - 1];
    const y = b.steps[b.steps.length - 1];
    return x.file.localeCompare(y.file) || x.line - y.line;
  });
  return { symbol: start, edge: kind, trails, truncated };
}

export function renderFollow(r: FollowResult): string {
  if (r.ambiguous) {
    const lines = ["ambiguous name — pick a qualified id:"];
    for (const c of r.candidates ?? []) lines.push(`  ${c.id}  ${c.file}:${c.line}`);
    return lines.join("\n");
  }
  if (!r.symbol) return "symbol not found";
  const lines: string[] = [];
  lines.push(`trails from ${r.symbol.name} (${r.symbol.kind}) via ${r.edge} edge:`);
  if (!r.trails.length) lines.push("  (no reachable symbols)");
  for (const t of r.trails) {
    const parts = t.steps.map((s, i) => (i === 0 ? `${s.name} ${s.file}:${s.line}` : `${s.edge} ${s.name} ${s.file}:${s.line}`));
    lines.push(`  ${parts.join(" → ")}`);
  }
  if (r.truncated) lines.push(`  (trail list truncated at ${MAX_TRAILS} — follow deeper with a qualified id)`);
  return lines.join("\n");
}
