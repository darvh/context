import type { Node } from "../parse";
import type { Extractor } from "./core";
import { newCtx } from "./core";
import { extractGo } from "./go";
import { extractTsJs } from "./ts";
import { extractPy } from "./py";
import { extractRg } from "./rg";
import type { FileFacts } from "../facts";
import { parse } from "../parse";
import { rgLangFor } from "../lang";

const EXTRACTOR_MAP: Record<string, Extractor> = {
  go: extractGo,
  ts: extractTsJs,
  js: extractTsJs,
  py: extractPy,
};

export function extractorFor(lang: string): Extractor | null {
  return EXTRACTOR_MAP[lang] ?? null;
}

export async function extractFile(file: string, lang: string, source: string, hash: string): Promise<FileFacts> {
  const ctx = newCtx(file, lang, hash, source);
  const ext = extractorFor(lang);
  if (ext) {
    const parsed = await parse(lang, source);
    if (!parsed) return { file, lang, hash, symbols: [], edges: [], imports: [] };
    try {
      const root: Node = parsed.tree.rootNode;
      if (!root.hasError) ext(root, ctx);
    } finally {
      parsed.dispose();
    }
    return { file, lang, hash, symbols: ctx.symbols, edges: ctx.edges, imports: ctx.imports };
  }
  // rg fallback: line-based heuristics, no WASM needed — supports 20+ langs via rules.ts
  const rgLang = rgLangFor(file) ?? lang;
  if (rgLang) {
    extractRg(ctx);
    return { file, lang: rgLang, hash, symbols: ctx.symbols, edges: ctx.edges, imports: ctx.imports };
  }
  return { file, lang, hash, symbols: [], edges: [], imports: [] };
}
