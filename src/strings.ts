import { promises as fs } from "node:fs";
import path from "node:path";
import type { Graph } from "./facts";

/** Runtime strings: bounded string literals from each symbol's body, attached
 *  to the symbol so the lexical lane can match error/log/config strings the
 *  name/sig/doc cannot see. Deterministic, source-backed, cached with the
 *  graph (SymbolFact.strings). */

const MAX_STRINGS = 8;
const STRING_RE = /"([^"\\\n]{3,80})"|'([^'\\\n]{3,80})'|`([^`\\\n]{3,80})`/g;
const MAX_BODY_LINES = 40;

export async function attachRuntimeStrings(root: string, graph: Graph): Promise<void> {
  const cache = new Map<string, string>();
  const readFile = async (f: string): Promise<string> => {
    let t = cache.get(f);
    if (t === undefined) {
      t = await fs.readFile(path.join(root, f), "utf8").catch(() => "");
      cache.set(f, t);
    }
    return t;
  };
  for (const s of graph.symbols) {
    if (s.kind === "import" || s.strings !== undefined) continue; // [] = checked, none found
    const source = await readFile(s.file);
    const from = Math.max(0, s.span.sl - 1);
    const to = Math.min(source.split("\n").length, s.span.el + 2, from + MAX_BODY_LINES);
    const body = source.split("\n").slice(from, to).join("\n");
    const strings: string[] = [];
    STRING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_RE.exec(body)) && strings.length < MAX_STRINGS) {
      const lit = (m[1] ?? m[2] ?? m[3]).trim();
      if (lit && !strings.includes(lit)) strings.push(lit);
    }
    s.strings = strings; // empty = checked and none found
  }
}
