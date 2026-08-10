import type { Node } from "../parse";
import type { Extractor } from "./core";
import { newCtx } from "./core";
import { extractGo } from "./go";
import { extractTsJs } from "./ts";
import { extractPy } from "./py";
import type { FileFacts } from "../facts";
import { parse } from "../parse";

export function extractorFor(lang: string): Extractor | null {
  if (lang === "go") return extractGo;
  if (lang === "ts" || lang === "js") return extractTsJs;
  if (lang === "py") return extractPy;
  return null;
}

export async function extractFile(file: string, lang: string, source: string, hash: string): Promise<FileFacts> {
  const ctx = newCtx(file, lang, hash, source);
  const ext = extractorFor(lang);
  if (!ext) return { file, lang, hash, symbols: [], edges: [], imports: [] };
  const parsed = await parse(lang, source);
  if (!parsed) return { file, lang, hash, symbols: [], edges: [], imports: [] };
  try {
    const root: Node = parsed.tree.rootNode;
    if (!root.hasError) ext(root, ctx);
  } finally {
    parsed.dispose();
  }
  return {
    file,
    lang,
    hash,
    symbols: ctx.symbols,
    edges: ctx.edges,
    imports: ctx.imports,
  };
}
