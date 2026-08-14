import path from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { LANGS, grammarDir, type LangConf } from "./lang";

// web-tree-sitter types namedChildren as (Node|null)[] and every accessor as
// nullable, but the extractors treat the tree as fully materialized. Cast once
// at the boundary with a structural subset: named children non-null,
// optional-child accessors stay nullable so call sites still guard.
export interface Node {
  readonly id: number;
  readonly text: string;
  readonly type: string;
  readonly parent: Node | null;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly namedChildren: Node[];
  readonly hasError: boolean;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  child(i: number): Node | null;
  namedChild(i: number): Node | null;
  fieldNameForChild(i: number): string | null;
}

let initP: Promise<void> | null = null;

// web-tree-sitter 0.25 needs its base runtime wasm at init time. Dev mode
// reads it from node_modules; the packaged binary finds it next to the
// language grammars (copied by scripts/embed-grammars.ts). We pass the bytes
// directly (`wasmBinary`) because bun's bundler rewrites the default
// `new URL("tree-sitter.wasm", import.meta.url)` fetch into a missing $bunfs
// path inside compiled binaries.
function baseWasmPath(): string {
  return path.join(grammarDir(), "web-tree-sitter", "tree-sitter.wasm");
}

function ensureInit(): Promise<void> {
  if (!initP) {
    initP = (async () => {
      const bytes = await Bun.file(baseWasmPath()).arrayBuffer();
      await Parser.init({ wasmBinary: new Uint8Array(bytes) });
    })();
  }
  return initP;
}

const langCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Parser>();

async function loadLang(l: LangConf): Promise<Language> {
  let p = langCache.get(l.name);
  if (!p) {
    p = (async () => {
      const wasm = await Bun.file(l.wasm).arrayBuffer();
      return Language.load(new Uint8Array(wasm));
    })();
    langCache.set(l.name, p);
  }
  return p;
}

function parserFor(l: LangConf): Parser {
  let parser = parserCache.get(l.name);
  if (!parser) {
    parser = new Parser();
    parserCache.set(l.name, parser);
  }
  return parser;
}

/** Parse source with the given language; caller must tree.delete() via dispose(). */
export async function parse(
  langName: string,
  source: string,
): Promise<{ tree: { rootNode: Node }; dispose: () => void } | null> {
  try {
    await ensureInit();
    const l = LANGS.find((x) => x.name === langName);
    if (!l) return null;
    const lang = await loadLang(l);
    const parser = parserFor(l);
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (!tree) return null;
    return {
      tree: { rootNode: tree.rootNode as unknown as Node },
      dispose: () => tree.delete(),
    };
  } catch {
    return null;
  }
}


