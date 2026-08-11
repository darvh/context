import Parser from "web-tree-sitter";
import { LANGS, type LangConf } from "./lang";

export type Node = Parser.SyntaxNode;

let initP: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initP) initP = Parser.init();
  return initP;
}

const langCache = new Map<string, Promise<Parser.Language>>();
const parserCache = new Map<string, Parser>();

async function loadLang(l: LangConf): Promise<Parser.Language> {
  let p = langCache.get(l.name);
  if (!p) {
    p = (async () => {
      const wasm = await Bun.file(l.wasm).arrayBuffer();
      return Parser.Language.load(new Uint8Array(wasm));
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
    return {
      tree: { rootNode: tree.rootNode },
      dispose: () => tree.delete(),
    };
  } catch {
    return null;
  }
}


