import { createHash } from "node:crypto";

/**
 * Office/PDF conversion is optional: `@firecrawl/anydoc` ships a native module
 * per platform, and a checkout installed for one platform (or without the
 * optional binding) must not stop the CLI from starting. Load it on first use
 * and fail open — the branch below already returns "" on any extraction error.
 */
type AnyDocConvert = typeof import("@firecrawl/anydoc").toMarkdownBytes;
let anydoc: Promise<AnyDocConvert> | undefined;

function loadAnyDoc(): Promise<AnyDocConvert> {
  if (!anydoc) {
    anydoc = import("@firecrawl/anydoc")
      .then((module) => module.toMarkdownBytes)
      .catch((error) => {
        anydoc = undefined; // a later call may succeed (e.g. after an install)
        throw error;
      });
  }
  return anydoc;
}

/**
 * Docs lane: deterministic, model-free extraction for non-code files.
 * Kept separate from the code/symbol lane — docs never enter the symbol graph;
 * their text feeds the BM25 + semantic indexes so `context observe` can
 * surface them. Fail-open: any extraction error yields empty text.
 *
 * Extraction: a small local HTML normalizer, @firecrawl/anydoc (Rust core,
 * local, no LLM) for office/PDF formats, and direct reads for plain prose.
 * Structured data files stay outside this lane.
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

// Prose/markup documents — cheap, no converter needed.
// Structured files stay readable via `context read`, but are not added to the
// prose docs lane: their keys/values belong to artifact/config retrieval.
const PROSE_TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".rst",
  ".adoc",
  ".txt",
  ".html",
  ".htm",
  ".log",
]);

// anydoc-supported formats (content-detected, no extension needed)
export const ANYDOC_EXTS = new Set([
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
  return PROSE_TEXT_EXTS.has(ext) || ANYDOC_EXTS.has(ext);
}

function cleanText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtml(raw: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  const point = (value: string, radix: number, original: string) => {
    const code = Number.parseInt(value, radix);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
  };
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (full, hex) => point(hex, 16, full))
    .replace(/&#(\d+);/g, (full, dec) => point(dec, 10, full))
    .replace(/&([a-z]+);/gi, (full, name) => named[name.toLowerCase()] ?? full);
}

function stripTags(raw: string): string {
  return raw.replace(/<[^>]+>/g, "");
}

function safeHref(raw: string): string {
  const href = decodeHtml(raw).trim();
  return /^(?:javascript|data|vbscript):/i.test(href) ? "" : href;
}

/** Bounded converter for saved HTML; fetching and DOM execution happen elsewhere. */
function htmlToMarkdown(raw: string): string {
  let text = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeHtml(stripTags(code)).trim()}\n\`\`\`\n\n`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = stripTags(label);
      const safe = safeHref(href);
      return safe ? `[${text}](${safe})` : text;
    })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, "$1")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|p|div|section|article|main|header|footer|blockquote|tr|table|ul|ol|td|th)>/gi, "\n")
    .replace(/<(p|div|section|article|main|header|footer|blockquote|tr|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return cleanText(decodeHtml(text));
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
  if (PROSE_TEXT_EXTS.has(ext)) {
    const text = new TextDecoder().decode(bytes);
    return ext === ".html" || ext === ".htm" ? htmlToMarkdown(text) : cleanText(text);
  }
  if (ANYDOC_EXTS.has(ext)) {
    try {
      const convert = await loadAnyDoc();
      return cleanText(await convert(bytes));
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
