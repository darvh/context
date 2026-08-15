import { promises as fs } from "node:fs";
import path from "node:path";

/** Resolve a repository-relative path without following it outside root. */
export async function repoPath(root: string, input: string): Promise<{ rel: string; path: string } | null> {
  const base = await fs.realpath(root).catch(() => path.resolve(root));
  const lexical = path.resolve(base, input);
  const lexicalRel = path.relative(base, lexical);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) return null;
  const real = await fs.realpath(lexical).catch(() => null);
  if (!real) return null;
  const realRel = path.relative(base, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  return { rel: lexicalRel, path: real };
}
