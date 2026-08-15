import { Database } from "bun:sqlite";
import type { Graph } from "../core/facts";
import type { DocFact } from "../core/doc";
import { terms } from "./query";
import { STOP_WORDS } from "../core/rules";

/**
 * Sparse lexical index over symbol records (name, signature, doc, path) plus
 * doc records (extracted non-code text). SQLite FTS5 + BM25. One row per
 * symbol; long docs are indexed per SECTION (bounded units) so a 25KB file
 * can't bury its answer. In-memory, rebuilt per command (the symbol set is
 * already cached in the graph). Deterministic.
 */
export interface Bm25Index {
  db: Database;
  rows: number;
  sizeBytes: number;
  symCount: number; // symbols occupy rowids [0, symCount)
  /** rowid of the first section row of each doc */
  docOffsets: number[];
}

export interface Bm25Hit {
  kind: "sym" | "doc";
  rowid: number; // sym: index into graph.symbols
  score: number; // lower = better (BM25)
  doc?: number; // doc: index into docs
  section?: number; // doc: index into that doc's sections
}

export function buildBm25Index(graph: Graph, docs: DocFact[] = []): Bm25Index {
  const db = new Database(":memory:");
  db.run(`CREATE VIRTUAL TABLE syms USING fts5(name, sig, doc, path, tokenize='porter')`);
  db.run(`CREATE VIRTUAL TABLE docs USING fts5(text, path, tokenize='porter')`);
  const insSym = db.prepare(`INSERT INTO syms(rowid, name, sig, doc, path) VALUES (?,?,?,?,?)`);
  const insDoc = db.prepare(`INSERT INTO docs(rowid, text, path) VALUES (?,?,?)`);
  let sizeBytes = 0;
  graph.symbols.forEach((s, i) => {
    insSym.run(i, s.name, s.sig, s.doc, s.file);
    sizeBytes += s.name.length + s.sig.length + s.doc.length + s.file.length;
  });
  const docOffsets: number[] = [];
  let rowid = graph.symbols.length;
  docs.forEach((d, i) => {
    docOffsets.push(rowid);
    for (const sec of d.sections.length ? d.sections : [{ text: d.text, line: 1 }]) {
      insDoc.run(rowid++, sec.text, d.file);
      sizeBytes += sec.text.length + d.file.length;
    }
  });
  return { db, rows: rowid, sizeBytes, symCount: graph.symbols.length, docOffsets };
}

/** FTS query string for a task — shared by search and the bench's hardness probe. */
export function bm25Query(task: string): string {
  return terms(task)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

/** Rank symbols + docs by BM25 for a task; empty when no query term is present. */
export function bm25Search(idx: Bm25Index, task: string, limit = 20): Bm25Hit[] {
  const q = bm25Query(task);
  if (!q) return [];
  const out: Bm25Hit[] = [];
  const symRows = idx.db.prepare(
    `SELECT rowid, bm25(syms) AS s FROM syms WHERE syms MATCH ? ORDER BY s ASC LIMIT ?`,
  ).all(q, limit) as { rowid: number; s: number }[];
  for (const r of symRows) out.push({ kind: "sym", rowid: r.rowid, score: r.s });
  const docRows = idx.db.prepare(
    `SELECT rowid, bm25(docs) AS s FROM docs WHERE docs MATCH ? ORDER BY s ASC LIMIT ?`,
  ).all(q, limit) as { rowid: number; s: number }[];
  for (const r of docRows) {
    // binary-search the doc whose section range contains this rowid
    const offs = idx.docOffsets;
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= r.rowid) lo = mid;
      else hi = mid - 1;
    }
    out.push({ kind: "doc", rowid: r.rowid, score: r.s, doc: lo, section: r.rowid - offs[lo] });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}
