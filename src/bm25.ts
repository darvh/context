import { Database } from "bun:sqlite";
import type { Graph } from "./facts";
import type { DocFact } from "./doc";
import { terms, STOP_WORDS } from "./query";

/**
 * Sparse lexical index over symbol records (name, signature, doc, path) plus
 * doc records (extracted non-code text). SQLite FTS5 + BM25. One row per
 * symbol / doc. In-memory, rebuilt per command (the symbol set is already
 * cached in the graph). Deterministic.
 */
export interface Bm25Index {
  db: Database;
  rows: number;
  sizeBytes: number;
  symCount: number; // symbols occupy rowids [0, symCount)
}

export interface Bm25Hit {
  kind: "sym" | "doc";
  rowid: number; // sym: index into graph.symbols; doc: index into docs
  score: number; // lower = better (BM25)
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
  docs.forEach((d, i) => {
    insDoc.run(i, d.text, d.file);
    sizeBytes += d.text.length + d.file.length;
  });
  return { db, rows: graph.symbols.length + docs.length, sizeBytes, symCount: graph.symbols.length };
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
  for (const r of docRows) out.push({ kind: "doc", rowid: r.rowid, score: r.s });
  out.sort((a, b) => a.score - b.score);
  return out;
}
