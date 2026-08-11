import path from 'node:path';

export type LangName = 'go' | 'ts' | 'js' | 'py';

export interface LangConf {
  name: LangName;
  exts: string[];
  wasm: string; // resolved absolute path to grammar wasm
}

function grammarDir(): string {
  const env = process.env.CONTEXT_GRAMMAR_DIR;
  if (env && env.trim()) return env.endsWith('/') ? env : env + '/';
  try {
    const exe = (Bun as unknown as { executablePath?: string }).executablePath;
    if (exe && !exe.endsWith('/bun') && !exe.endsWith('bun')) {
      return path.join(path.dirname(exe), 'grammars') + '/';
    }
  } catch {}
  return path.join(import.meta.dir, '..', 'node_modules') + '/';
}

const DIR = grammarDir();

export const LANGS: LangConf[] = [
  { name: 'go', exts: ['.go'], wasm: DIR + 'tree-sitter-go/tree-sitter-go.wasm' },
  {
    name: 'ts',
    exts: ['.ts', '.tsx', '.mts', '.cts'],
    wasm: DIR + 'tree-sitter-typescript/tree-sitter-typescript.wasm'
  },
  {
    name: 'js',
    exts: ['.js', '.jsx', '.mjs', '.cjs'],
    wasm: DIR + 'tree-sitter-javascript/tree-sitter-javascript.wasm'
  },
  { name: 'py', exts: ['.py'], wasm: DIR + 'tree-sitter-python/tree-sitter-python.wasm' }
];

export function langFor(path: string): LangConf | undefined {
  const i = path.lastIndexOf('.');
  if (i < 0) return undefined;
  const ext = path.slice(i);
  return LANGS.find((l) => l.exts.includes(ext));
}

// Source extensions with no tree-sitter grammar: get the rg-level fallback
// extractor instead of no facts at all.
const RG_EXTS = new Set([
  '.rb',
  '.java',
  '.rs',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.kt',
  '.kts',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.lua',
  '.r',
  '.scala',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.m',
  '.mm'
]);

export function rgLangFor(path: string): string | null {
  const i = path.lastIndexOf('.');
  if (i < 0) return null;
  const ext = path.slice(i);
  return RG_EXTS.has(ext) ? ext.slice(1) : null;
}
