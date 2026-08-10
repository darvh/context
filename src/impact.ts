import type { BuildResult } from "./build";
import type { Edge, SymbolFact } from "./facts";

export interface ImpactReport {
  symbol?: SymbolFact;
  callers: { symbol: string; file: string; line: number; conf: string }[];
  callees: { name: string; file: string; line: number; conf: string }[];
  relations: { kind: string; name: string; file: string; line: number; conf: string }[];
  tests: { name: string; file: string; line: number }[];
  changedFiles: string[];
  changed: boolean;
}

const CONF_TEXT: Record<string, string> = {
  exact: "exact",
  resolved: "resolved",
  heuristic: "heuristic",
};

function edgeLoc(e: Edge): { file: string; line: number } {
  const i = e.at.lastIndexOf(":");
  const file = i >= 0 ? e.at.slice(0, i) : e.at;
  const line = i >= 0 ? Number(e.at.slice(i + 1)) : 0;
  return { file, line };
}

export function impact(b: BuildResult, symbolName?: string, diffOnly = false): ImpactReport {
  const byName = new Map<string, SymbolFact[]>();
  for (const s of b.graph.symbols) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);

  const changedFiles = [...b.changed].sort();

  if (diffOnly) {
    return {
      callers: [],
      callees: [],
      relations: [],
      tests: [],
      changedFiles,
      changed: true,
    };
  }

  if (!symbolName) {
    return { callers: [], callees: [], relations: [], tests: [], changedFiles, changed: false };
  }

  const cands = byName.get(symbolName);
  if (!cands) return { callers: [], callees: [], relations: [], tests: [], changedFiles, changed: false };
  const sym = cands[0];
  const id = sym.id;

  const callers: ImpactReport["callers"] = [];
  const callees: ImpactReport["callees"] = [];
  const relations: ImpactReport["relations"] = [];
  const tests: ImpactReport["tests"] = [];

  for (const e of b.graph.edges) {
    const loc = edgeLoc(e);
    if (e.to === id) {
      if (e.kind === "call" || e.kind === "ref") callers.push({ symbol: e.name, ...loc, conf: CONF_TEXT[e.conf] });
      else if (e.kind === "test") tests.push({ name: e.name, ...loc });
      else relations.push({ kind: e.kind, name: e.name, ...loc, conf: CONF_TEXT[e.conf] });
    }
    if (e.from === id) {
      if (e.kind === "call" || e.kind === "ref") callees.push({ name: e.name, ...loc, conf: CONF_TEXT[e.conf] });
      else if (e.kind === "inherit" || e.kind === "implement" || e.kind === "contain")
        relations.push({ kind: e.kind, name: e.name, ...loc, conf: CONF_TEXT[e.conf] });
    }
  }

  return {
    symbol: sym,
    callers,
    callees,
    relations,
    tests,
    changedFiles,
    changed: changedFiles.includes(sym.file),
  };
}

export function renderImpact(r: ImpactReport, diffOnly: boolean): string {
  const lines: string[] = [];
  if (diffOnly) {
    lines.push(`changed files: ${r.changedFiles.length}`);
    for (const f of r.changedFiles) lines.push(`  ${f}`);
    return lines.join("\n");
  }
  if (!r.symbol) {
    lines.push("symbol not found");
    lines.push(`changed files: ${r.changedFiles.length}`);
    return lines.join("\n");
  }
  lines.push(`symbol: ${r.symbol.name} (${r.symbol.kind}) ${r.symbol.file}:${r.symbol.nameLine}`);
  lines.push(`sig: ${r.symbol.sig}`);
  lines.push(`changed: ${r.changed}`);
  lines.push(`\ncallers: ${r.callers.length}`);
  for (const c of r.callers) lines.push(`  ${c.file}:${c.line} ${c.symbol} [${c.conf}]`);
  lines.push(`\ncallees: ${r.callees.length}`);
  for (const c of r.callees) lines.push(`  ${c.file}:${c.line} ${c.name} [${c.conf}]`);
  lines.push(`\nrelations: ${r.relations.length}`);
  for (const c of r.relations) lines.push(`  ${c.file}:${c.line} ${c.kind} ${c.name} [${c.conf}]`);
  lines.push(`\ntests: ${r.tests.length}`);
  for (const c of r.tests) lines.push(`  ${c.file}:${c.line} ${c.name}`);
  lines.push(`\nchanged files: ${r.changedFiles.length}`);
  for (const f of r.changedFiles) lines.push(`  ${f}`);
  return lines.join("\n");
}
