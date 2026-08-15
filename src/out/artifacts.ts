import { promises as fs } from "node:fs";
import path from "node:path";
import type { SymbolFact } from "../core/facts";
import { langFor, rgLangFor } from "../core/lang";
import { makeId } from "../core/facts";

/** Typed artifact facts: environment variables and config keys mentioned in
 *  code become first-class config symbols, so "DATABASE_URL" or "the cache
 *  ttl setting" resolves exactly even when no code symbol names them.
 *  Deterministic regex scan over code files; never reads outside the tree. */

const MAX_ARTIFACTS = 200;

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /os\.Getenv\(["']([A-Z][A-Z0-9_]+)["']\)/g,
  /os\.getenv\(["']([A-Z][A-Z0-9_]+)["']\)/g,
  /os\.environ(?:\.get|\[)\(?["']([A-Z][A-Z0-9_]+)/g,
  /ENV\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /getenv\(["']([A-Z][A-Z0-9_]+)["']\)/g,
  /std::env::var\(["']([A-Z][A-Z0-9_]+)["']\)/g,
];

const CONFIG_KEY_PATTERNS: RegExp[] = [
  /config\.get\(["']([a-z0-9_.-]+)["']\)/g,
  /getConfig\(["']([a-z0-9_.-]+)["']\)/g,
  /config\[["']([a-z0-9_.-]+)["']\]/g,
];

export async function extractArtifacts(root: string, files: string[]): Promise<SymbolFact[]> {
  const out: SymbolFact[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!langFor(f) && !rgLangFor(f)) continue;
    let source: string;
    try {
      source = await fs.readFile(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    const add = (name: string, line: number, kind: "config") => {
      const id = makeId(f, name, line);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        file: f,
        kind,
        name,
        sig: "",
        span: { sl: line, sc: 1, el: line, ec: 1 },
        nameLine: line,
        exported: false,
        test: false,
        doc: kind === "config" && /^[A-Z]/.test(name) ? "environment variable" : "configuration key",
        conf: "exact",
      });
    };
    for (const re of [...ENV_PATTERNS, ...CONFIG_KEY_PATTERNS]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) && out.length < MAX_ARTIFACTS) {
        const line = source.slice(0, m.index).split("\n").length;
        add(m[1], line, "config");
      }
    }
  }
  return out;
}
