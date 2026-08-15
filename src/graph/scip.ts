import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@c4312/scip";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { OverlayFacts } from "../graph/overlay";

/** Compiler-backed SCIP index ingest: reads `index.scip` (binary protobuf) at
 *  the walked root and converts it to the documented OverlayFacts schema,
 *  which mergeOverlay fuses into the tree-sitter graph. Tree-sitter behavior
 *  is unchanged when no index exists. Confidence is exact: compiler-backed. */

const SCIP_FILE = "index.scip";
const MAX_SYMBOLS = 5000;
const MAX_EDGES = 5000;

// SCIP SymbolRole bit flags
const ROLE_DEFINITION = 4;
const ROLE_REFERENCE = 16;

// SCIP SymbolInformation_Kind -> our Kind (only the common ones; default type)
const KIND_MAP: Record<number, string> = {
  9: "class", // Class
  10: "const", // Constant
  11: "function", // Constructor
  15: "type", // Enum
  16: "const", // EnumMember
  19: "const", // Field
  21: "function", // Function
  26: "interface", // Interface
  31: "method", // Method
  44: "const", // Property
  52: "struct", // Struct
  54: "interface", // Trait
  57: "type", // TypeAlias
  62: "var", // Variable
};

/** Last descriptor segment of a SCIP moniker is the symbol name:
 *  `typescript src/a.ts;func::open` -> open, `golang pkg;func NewHandler` -> NewHandler. */
export function nameFromMoniker(symbol: string): string {
  const last = symbol.split(";").pop() ?? "";
  let name = last;
  if (name.includes("::")) name = name.split("::").pop()!;
  else if (name.includes(" ")) name = name.split(" ").pop()!;
  else if (name.includes(".")) name = name.split(".").pop()!;
  return name.replace(/[()<>\s]/g, "");
}

function lineAt(bytes: Uint8Array, byte: number): number {
  let line = 1;
  const end = Math.min(byte, bytes.length);
  for (let i = 0; i < end; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

interface Def {
  id: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  startByte: number;
  endByte: number;
  symbol: string;
}

export async function loadScipIndex(root: string): Promise<OverlayFacts | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(path.join(root, SCIP_FILE)));
  } catch {
    return null; // no index: tree-sitter behavior unchanged
  }
  try {
    const idx = fromBinary(IndexSchema, bytes);
    if (!idx.documents.length) return null;
    return await indexToOverlay(root, idx);
  } catch {
    return null; // malformed index degrades to tree-sitter
  }
}

async function indexToOverlay(root: string, idx: import("@c4312/scip").Index): Promise<OverlayFacts | null> {
  const fileCache = new Map<string, Uint8Array>();
  const readFile = async (rel: string): Promise<Uint8Array> => {
    let b = fileCache.get(rel);
    if (b === undefined) {
      b = new Uint8Array(0);
      try {
        b = new Uint8Array(await Bun.file(path.join(root, rel)).arrayBuffer());
      } catch {}
      fileCache.set(rel, b);
    }
    return b;
  };

  // pass 1: definition occurrences -> symbol facts
  const defs = new Map<string, Def>(); // symbol string -> def
  const infoBySymbol = new Map<string, import("@c4312/scip").SymbolInformation>();
  for (const doc of idx.documents) {
    for (const info of doc.symbols ?? []) infoBySymbol.set(info.symbol, info);
    const fileBytes = await readFile(doc.relativePath);
    for (const occ of doc.occurrences ?? []) {
      if (!occ.symbol || !(occ.symbolRoles & ROLE_DEFINITION)) continue;
      const name = nameFromMoniker(occ.symbol);
      if (!name) continue;
      const line = lineAt(fileBytes, occ.range[0] ?? 0);
      const endLine = lineAt(fileBytes, occ.range[1] ?? 0);
      const id = `${doc.relativePath}::${name}::${line}`;
      defs.set(occ.symbol, { id, name, file: doc.relativePath, line, endLine, startByte: occ.range[0] ?? 0, endByte: occ.range[1] ?? 0, symbol: occ.symbol });
    }
  }

  const symbols = [...defs.values()].slice(0, MAX_SYMBOLS).map((d) => {
    const info = infoBySymbol.get(d.symbol);
    const kind = (info && KIND_MAP[info.kind as number]) || "type";
    const doc = info?.documentation?.slice(0, 300).join(" ") ?? "";
    return { id: d.id, file: d.file, name: d.name, kind, line: d.line, endLine: d.endLine, sig: "", doc };
  });

  const edges: OverlayFacts["edges"] = [];
  const defIdBySymbol = new Map([...defs.entries()].map(([s, d]) => [s, d.id]));

  // pass 2: reference occurrences -> edges from the enclosing definition
  // (containment, else the nearest preceding definition in the document)
  const perDoc = new Map<string, Def[]>();
  for (const d of defs.values()) perDoc.set(d.file, [...(perDoc.get(d.file) ?? []), d]);
  for (const d of perDoc.values()) d.sort((a, b) => a.startByte - b.startByte);

  for (const doc of idx.documents) {
    const fileBytes = await readFile(doc.relativePath);
    const docDefs = perDoc.get(doc.relativePath) ?? [];
    for (const occ of doc.occurrences ?? []) {
      if (!occ.symbol || !(occ.symbolRoles & ROLE_REFERENCE)) continue;
      const start = occ.range[0] ?? 0;
      // enclosing definition by containment, else nearest preceding
      let from: Def | undefined;
      for (const d of docDefs) {
        if (start >= d.startByte && start < Math.max(d.endByte, d.startByte + 1)) {
          from = d;
          break;
        }
      }
      if (!from) {
        let best: Def | undefined;
        for (const d of docDefs) {
          if (d.startByte <= start) best = d;
          else break;
        }
        from = best;
      }
      if (!from) continue;
      const to = defIdBySymbol.get(occ.symbol);
      if (to === from.id) continue;
      edges.push({ from: from.id, to: to ?? "", kind: "ref", at: `${doc.relativePath}:${lineAt(fileBytes, start)}` });
    }
    if (edges.length >= MAX_EDGES) break;
  }

  // pass 3: implementations/inheritance relationships
  for (const [symbol, info] of infoBySymbol) {
    const fromId = defIdBySymbol.get(symbol);
    if (!fromId) continue;
    for (const rel of info.relationships ?? []) {
      if (!rel.symbol) continue;
      const to = defIdBySymbol.get(rel.symbol);
      const kind = rel.isImplementation ? "implement" : rel.isReference ? "ref" : "ref";
      edges.push({ from: fromId, to: to ?? "", kind, at: "" });
      if (edges.length >= MAX_EDGES) break;
    }
    if (edges.length >= MAX_EDGES) break;
  }

  if (!symbols.length && !edges.length) return null;
  return { version: 1, symbols, edges };
}
