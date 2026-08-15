import type { Node } from "../parse";
import type { Extractor } from "./core";
import { newCtx } from "./core";
import { extractGo } from "./go";
import { extractTsJs } from "./ts";
import { extractPy } from "./py";
import { extractGeneric } from "./generic";
import { extractRg } from "./rg";
import type { FileFacts } from "../facts";
import { parse } from "../parse";
import { rgLangFor } from "../lang";

const EXTRACTOR_MAP: Record<string, Extractor> = {
  go: extractGo,
  ts: extractTsJs,
  js: extractTsJs,
  py: extractPy,
  // AST-backed via the shared generic walker
  java: extractGeneric,
  rb: extractGeneric,
  rs: extractGeneric,
  c: extractGeneric,
  cpp: extractGeneric,
  cs: extractGeneric,
  php: extractGeneric,
  sh: extractGeneric,
};

function extractorFor(lang: string): Extractor | null {
  return EXTRACTOR_MAP[lang] ?? null;
}

export async function extractFile(file: string, lang: string, source: string, hash: string): Promise<FileFacts> {
  const ctx = newCtx(file, lang, hash, source);
  const finish = (langName: string): FileFacts => ({ file, lang: langName, hash, symbols: ctx.symbols, edges: ctx.edges, imports: ctx.imports });
  const ext = extractorFor(lang);
  if (ext) {
    const parsed = await parse(lang, source);
    if (parsed) {
      try {
        const root: Node = parsed.tree.rootNode;
        if (!root.hasError) ext(root, ctx);
      } finally {
        parsed.dispose();
      }
      return finish(lang);
    }
    // grammar unavailable at runtime (missing wasm): fall back to rg heuristics
    if (rgLangFor(file) || lang !== "rg") {
      extractRg(ctx);
      return finish(rgLangFor(file) ?? lang);
    }
    return finish(lang);
  }
  // rg fallback: line-based heuristics, no WASM needed — supports 20+ langs via rules.ts
  const rgLang = rgLangFor(file) ?? lang;
  if (rgLang) {
    extractRg(ctx);
    return finish(rgLang);
  }
  return finish(lang);
}
