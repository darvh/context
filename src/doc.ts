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
 *
 * Long documents are split into BOUNDED sections (headings / paragraph runs)
 * instead of one truncated record: a 25KB RST file as one record buries the
 * answer under its own length. Sections carry their start line so `context
 * expand` can point at the region that matched. (Section-level SEMANTIC
 * embedding was benchmarked and regressed recall — isolated sections score
 * below the sim floor and extra targets dilute the top-10 — so the semantic
 * lane embeds the full bounded text and only BM25 indexes sections.)
 */

interface DocSection {
  text: string;
  /** 1-based start line in the source file; 1 when the format has no lines (anydoc) */
  line: number;
  /** 1-based end line (inclusive) — the section's full range for pinpoint */
  endLine: number;
}

export interface DocFact {
  file: string;
  text: string; // full extracted text (bounded), for the semantic lane
  sections: DocSection[]; // bounded retrieval units for the BM25 lane
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
const MAX_DOC_CHARS = 64_000; // bound whole-doc text (semantic lane)
const MAX_SECTION_CHARS = 4_000; // bound each retrieval unit (BM25 lane)
const MAX_SECTIONS = 40; // cap units per doc

export function isDocFile(path: string): boolean {
  const i = path.lastIndexOf(".");
  if (i < 0) return false;
  const ext = path.slice(i).toLowerCase();
  return TEXT_EXTS.has(ext) || ANYDOC_EXTS.has(ext);
}

function cleanText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split cleaned text into bounded sections, tracking each section's start and
 * end line. Headings and paragraph runs become separate units; the whole
 * document is never one row.
 */
function splitSections(text: string): DocSection[] {
  const lines = text.split("\n");
  const out: DocSection[] = [];
  let cur = "";
  let curLine = 1;
  const flush = (endLine: number) => {
    if (cur.trim().length >= 20) out.push({ text: cur.trim(), line: curLine, endLine });
    cur = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      if (cur.trim().length >= 20) flush(i);
      if (cur === "") curLine = i + 1;
      cur = line + "\n";
    } else if (/^\s*$/.test(line) && cur.trim().length >= 60) {
      flush(i);
    } else {
      if (cur === "") curLine = i + 1;
      cur += line + "\n";
    }
    if (cur.length >= MAX_SECTION_CHARS) flush(i);
  }
  flush(lines.length);
  return out.slice(0, MAX_SECTIONS).map((s) => ({ ...s, text: s.text.slice(0, MAX_SECTION_CHARS) }));
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
  const text = (await extractDocText(file, bytes)).slice(0, MAX_DOC_CHARS);
  return {
    file,
    text,
    sections: text.length ? splitSections(text) : [],
    hash: createHash("sha256").update(bytes as unknown as Buffer).digest("hex"),
    size: bytes.byteLength,
    mtimeMs: 0,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes as unknown as Buffer).digest("hex");
}
