import { toMarkdownBytes } from "@firecrawl/anydoc";
import { createHash } from "node:crypto";

/**
 * Docs lane: deterministic, model-free extraction for non-code files.
 * Kept separate from the code/symbol lane — docs never enter the symbol graph;
 * their text feeds the BM25 + semantic indexes so `context prepare` can
 * surface them. Fail-open: any extraction error yields empty text.
 *
 * Extraction: @firecrawl/anydoc (Rust core, local, no LLM) for office/PDF
 * formats; plain text read for markup/data formats. Format detection is
 * content-based in anydoc, so mislabeled files still convert.
 */

export interface DocFact {
  file: string;
  text: string;
  hash: string; // sha256 of file bytes, for change detection
  size: number;
  mtimeMs: number;
}

// read directly (already text) — cheap, no converter needed
const TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".rst",
  ".adoc",
  ".txt",
  ".html",
  ".htm",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".csv",
  ".xml",
  ".log",
]);

// anydoc-supported formats (content-detected, no extension needed)
const ANYDOC_EXTS = new Set([
  ".doc",
  ".docm",
  ".docx",
  ".ppt",
  ".pps",
  ".pot",
  ".pptx",
  ".pptm",
  ".ppsx",
  ".ppsm",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".xlsb",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".epub",
  ".pdf",
]);

export const MAX_DOC_BYTES = 50 * 1024 * 1024; // skip monsters
export const MAX_DOC_CHARS = 64_000; // bound indexed text

export function isDocFile(path: string): boolean {
  const i = path.lastIndexOf(".");
  if (i < 0) return false;
  const ext = path.slice(i).toLowerCase();
  return TEXT_EXTS.has(ext) || ANYDOC_EXTS.has(ext);
}

function cleanText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_DOC_CHARS);
}

async function extractDocText(file: string, bytes: Uint8Array): Promise<string> {
  const i = file.lastIndexOf(".");
  const ext = i >= 0 ? file.slice(i).toLowerCase() : "";
  if (TEXT_EXTS.has(ext)) return cleanText(new TextDecoder().decode(bytes));
  if (ANYDOC_EXTS.has(ext)) {
    try {
      return cleanText(await toMarkdownBytes(bytes));
    } catch {
      return "";
    }
  }
  return "";
}

/** Extract doc text with change-detection metadata. Deterministic; never throws. */
export async function extractDoc(file: string, bytes: Uint8Array): Promise<DocFact> {
  const text = await extractDocText(file, bytes);
  return {
    file,
    text,
    hash: createHash("sha256").update(bytes as unknown as Buffer).digest("hex"),
    size: bytes.byteLength,
    mtimeMs: 0,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes as unknown as Buffer).digest("hex");
}
