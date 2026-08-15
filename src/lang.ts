import path from 'node:path';

type LangName = 'go' | 'ts' | 'js' | 'py' | 'java' | 'rb' | 'rs' | 'c' | 'cpp' | 'cs' | 'php' | 'sh' | 'kt' | 'swift';

export interface LangConf {
  name: LangName;
  exts: string[];
  wasm: string; // resolved absolute path to grammar wasm
}

export function grammarDir(): string {
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
  { name: 'py', exts: ['.py'], wasm: DIR + 'tree-sitter-python/tree-sitter-python.wasm' },
  // new langs: AST-backed via the shared generic extractor (extract/generic.ts);
  // rg remains the fallback when a grammar has no usable wasm
  { name: 'java', exts: ['.java'], wasm: DIR + 'tree-sitter-java/tree-sitter-java.wasm' },
  { name: 'rb', exts: ['.rb'], wasm: DIR + 'tree-sitter-ruby/tree-sitter-ruby.wasm' },
  { name: 'rs', exts: ['.rs'], wasm: DIR + 'tree-sitter-rust/tree-sitter-rust.wasm' },
  { name: 'c', exts: ['.c', '.h'], wasm: DIR + 'tree-sitter-c/tree-sitter-c.wasm' },
  { name: 'cpp', exts: ['.cpp', '.hpp', '.cc', '.hh'], wasm: DIR + 'tree-sitter-cpp/tree-sitter-cpp.wasm' },
  { name: 'cs', exts: ['.cs'], wasm: DIR + 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm' },
  { name: 'php', exts: ['.php'], wasm: DIR + 'tree-sitter-php/tree-sitter-php.wasm' },
  { name: 'sh', exts: ['.sh', '.bash', '.zsh'], wasm: DIR + 'tree-sitter-bash/tree-sitter-bash.wasm' },
  { name: 'kt', exts: ['.kt', '.kts'], wasm: '' }, // rg-only: no usable wasm grammar (tree-sitter-kotlin fails to build)
  { name: 'swift', exts: ['.swift'], wasm: '' }, // rg-only: tree-sitter-swift ships native .node only, no wasm
];

export function langFor(path: string): LangConf | undefined {
  const i = path.lastIndexOf('.');
  if (i < 0) return undefined;
  const ext = path.slice(i);
  return LANGS.find((l) => l.exts.includes(ext));
}

// Source extensions with no tree-sitter grammar yet: rg-level fallback extractor.
// Once a wasm grammar is added to LANGS, remove its ext from here.
const RG_EXTS = new Set([
  '.lua',
  '.r',
  '.scala',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.m',
  '.mm',
  // keep a few still without wasm but useful via rg
  '.pl',
  '.pm',
]);

export function rgLangFor(path: string): string | null {
  const i = path.lastIndexOf('.');
  if (i < 0) return null;
  const ext = path.slice(i);
  return RG_EXTS.has(ext) ? ext.slice(1) : null;
}
