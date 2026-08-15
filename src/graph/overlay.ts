import { promises as fs } from "node:fs";
import path from "node:path";
import type { Edge, Graph, SymbolFact } from "../core/facts";

/** External facts overlay: merge compiler/LSP/SCIP-backed facts (exported as
 *  JSON) into the Tree-sitter graph. Tree-sitter remains the universal
 *  fallback; when a high-precision index exists it upgrades confidence and
 *  adds exact references/implementations. Binary SCIP parsing is deferred —
 *  the documented JSON schema below is the ingest contract for any indexer. */

interface OverlaySymbol {
  id: string; // must match the tree-sitter id convention: file::name::line
  file: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
  sig?: string;
  doc?: string;
}

interface OverlayEdge {
  from: string; // symbol id (tree-sitter convention)
  to: string; // symbol id, or "" for external
  kind: "call" | "ref" | "implement" | "inherit" | "test";
  at?: string; // "file:line"
}

export interface OverlayFacts {
  version: 1;
  symbols?: OverlaySymbol[];
  edges?: OverlayEdge[];
}

const OVERLAY_FILE = ".context/facts.json";

export async function loadOverlay(root: string): Promise<OverlayFacts | null> {
  try {
    const p = path.join(root, OVERLAY_FILE);
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as OverlayFacts;
    if (raw.version !== 1) return null;
    return raw;
  } catch {
    return null; // no overlay: tree-sitter behavior unchanged
  }
}

/** Merge overlay facts into the graph: existing symbols upgrade to exact
 *  confidence, overlay-only symbols (types, interfaces) are added, and edges
 *  append below tree-sitter edges. Deterministic. */
export function mergeOverlay(graph: Graph, overlay: OverlayFacts): Graph {
  if (!overlay.symbols?.length && !overlay.edges?.length) return graph;
  const symbols = [...graph.symbols];
  const byId = new Map(graph.symbols.map((s) => [s.id, s]));
  for (const os of overlay.symbols ?? []) {
    const existing = byId.get(os.id);
    if (existing) {
      // compiler-backed: exact definition confidence + precise range
      existing.conf = "exact";
      if (os.endLine) existing.span = { ...existing.span, el: os.endLine };
      if (os.sig) existing.sig = os.sig;
      continue;
    }
    const n: SymbolFact = {
      id: os.id,
      file: os.file,
      kind: (os.kind as SymbolFact["kind"]) || "type",
      name: os.name,
      sig: os.sig ?? "",
      span: { sl: os.line, sc: 1, el: os.endLine ?? os.line, ec: 1 },
      nameLine: os.line,
      exported: true,
      test: false,
      doc: os.doc ?? "",
      conf: "exact",
    };
    symbols.push(n);
    byId.set(n.id, n);
  }
  const edges: Edge[] = [...graph.edges];
  for (const oe of overlay.edges ?? []) {
    if (!byId.has(oe.from)) continue;
    edges.push({ from: oe.from, to: oe.to, name: oe.to.split("::")[1] ?? oe.to, kind: oe.kind, conf: oe.to ? "exact" : "heuristic", at: oe.at ?? `${oe.from.split("::")[0]}:1` });
  }
  return { symbols, edges, imports: graph.imports };
}
