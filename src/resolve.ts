import type { Edge, FileFacts, Graph, Import, SymbolFact } from "./facts";

/** Resolve heuristic refs/edges to real symbol ids across files. Deterministic. */
export function resolveFacts(files: FileFacts[]): Graph {
  const symbols: SymbolFact[] = [];
  const importsByFile = new Map<string, Import[]>();
  const byName = new Map<string, SymbolFact[]>(); // name -> symbols (all files)
  const moduleToFile = new Map<string, Set<string>>(); // module spec -> files importing it

  for (const f of files) {
    symbols.push(...f.symbols);
    importsByFile.set(f.file, f.imports);
    for (const s of f.symbols) {
      byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    }
    for (const imp of f.imports) {
      moduleToFile.set(imp.module, new Set([...(moduleToFile.get(imp.module) ?? []), f.file]));
    }
  }

  const nameIndex = new Map<string, Map<string, SymbolFact[]>>(); // file -> (name -> symbols)
  for (const s of symbols) {
    const m = nameIndex.get(s.file) ?? new Map();
    m.set(s.name, [...(m.get(s.name) ?? []), s]);
    nameIndex.set(s.file, m);
  }

  const importByLocal = new Map<string, Map<string, Import>>(); // file -> (local alias -> Import)
  for (const f of files) {
    const m = new Map<string, Import>();
    for (const imp of f.imports) m.set(imp.local, imp);
    importByLocal.set(f.file, m);
  }

  const edges: Edge[] = [];

  const resolveEdge = (e: Edge, file: string) => {
    if (e.to) {
      edges.push(e);
      return;
    }
    // 1. same-file exact
    const local = nameIndex.get(file)?.get(e.name);
    if (local && local.length === 1) {
      edges.push({ ...e, to: local[0].id, conf: "exact" });
      return;
    }
    if (local && local.length > 1) {
      edges.push({ ...e, to: local[0].id, conf: "resolved" });
      return;
    }
    // 2. import resolution: name matches an imported binding in this file
    const imports = importByLocal.get(file);
    const bound = imports?.get(e.name);
    if (bound) {
      const targets = byName.get(e.name);
      if (targets) {
        // prefer target in a file that imports (or is) the module
        const cand = targets.find((t) => moduleToFile.get(bound.module)?.has(t.file) || t.file === bound.module.replace(/["']/g, "")) ?? targets[0];
        edges.push({ ...e, to: cand.id, conf: "resolved" });
        return;
      }
      edges.push({ ...e, conf: "heuristic" });
      return;
    }
    // 3. unambiguous global name
    const glob = byName.get(e.name);
    if (glob && glob.length === 1 && glob[0].file !== file) {
      edges.push({ ...e, to: glob[0].id, conf: "resolved" });
      return;
    }
    edges.push(e); // stays heuristic xref
  };

  for (const f of files) {
    for (const e of f.edges) resolveEdge(e, f.file);
  }
  return { symbols, edges, imports: files.flatMap((f) => f.imports) };
}
