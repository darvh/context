import type { Graph } from "../core/facts";
import type { DocFact } from "../core/doc";

/** Code↔document evidence links: high-confidence, deterministic edges from a
 *  document section to the code it mentions. Only exact token/path matches
 *  (qualified symbols, exported names, file paths) — no semantic links.
 *  Gives document retrieval a route into the code graph and code retrieval a
 *  route to its specification. */

export interface DocLink {
  doc: string; // document file
  section: number; // section index (0-based)
  kind: "path" | "symbol";
  target: string; // file path for "path", symbol id for "symbol"
  mention: string; // the matched token as written in the doc
}

const MAX_LINKS_PER_DOC = 8;
const MAX_LINKS = 64;
const MIN_NAME_LEN = 3;

export function buildDocLinks(graph: Graph, docs: DocFact[]): DocLink[] {
  if (!docs.length || !graph.symbols.length) return [];
  const out: DocLink[] = [];

  // exported symbol names with word boundaries are the high-confidence target
  const nameRe = new Map<string, RegExp>();
  for (const s of graph.symbols) {
    if (s.kind === "import") continue;
    if (!s.exported && s.kind !== "function" && s.kind !== "class" && s.kind !== "struct") continue;
    if (s.name.length < MIN_NAME_LEN) continue;
    if (s.name.includes(" ") || s.name.includes("(")) continue;
    if (!nameRe.has(s.name)) nameRe.set(s.name, new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  }
  const nameToId = new Map<string, string>();
  for (const s of graph.symbols) if (!nameToId.has(s.name)) nameToId.set(s.name, s.id);

  const files = new Set(graph.symbols.map((s) => s.file));

  outer: for (const d of docs) {
    let perDoc = 0;
    for (let i = 0; i < d.sections.length; i++) {
      const text = d.sections[i].text;
      if (text.length < MIN_NAME_LEN) continue;
      // path mentions are unambiguous (long, dot-separated)
      for (const f of files) {
        if (text.includes(f)) {
          out.push({ doc: d.file, section: i, kind: "path", target: f, mention: f });
          perDoc++;
          if (perDoc >= MAX_LINKS_PER_DOC || out.length >= MAX_LINKS) break outer;
          break; // one path link per section is enough
        }
      }
      // exported-name mentions
      for (const [name, re] of nameRe) {
        if (!re.test(text)) continue;
        const id = nameToId.get(name);
        if (!id) continue;
        out.push({ doc: d.file, section: i, kind: "symbol", target: id, mention: name });
        perDoc++;
        if (perDoc >= MAX_LINKS_PER_DOC || out.length >= MAX_LINKS) break outer;
      }
    }
  }
  return out;
}

