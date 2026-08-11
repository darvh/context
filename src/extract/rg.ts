import type { Node } from "../parse";
import type { Ctx } from "./core";
import { addSym, classifyFile, promoteKinds } from "./core";
import { RG_DECL, RG_IMPORT_RES, rgKindFromLine } from "./rules";

function lineNode(row: number, line: string): Node {
  return {
    type: "line",
    text: line,
    startPosition: { row, column: 0 },
    endPosition: { row, column: line.length },
    parent: null,
    childCount: 0,
    namedChildCount: 0,
    children: [],
    namedChildren: [],
    child: () => null,
    namedChild: () => null,
    fieldNameForChild: () => null,
    descendantsOfType: () => [],
  } as unknown as Node;
}

function matchName(line: string, re: RegExp): string | null {
  const m = re.exec(line);
  return m ? m[1] : null;
}

const SKIP_START = /^(if|for|while|switch|catch|return|elif|else)\b/;

export function extractRg(ctx: Ctx): void {
  // use lang-specific patterns if available (java, rb, rs, etc), fallback to generic rg
  const { isTest: isTestFile, isEntry, isConfig } = classifyFile(ctx.file, ctx.lang);

  const declList = [RG_DECL.fn, RG_DECL.class, RG_DECL.type, RG_DECL.const, RG_DECL.phpClass, RG_DECL.cFunc, RG_DECL.shFunc];

  for (let i = 0; i < ctx.lines.length; i++) {
    const line = ctx.lines[i];
    let trimmed = line.trim();
    if (!trimmed) continue;
    // strip php opening tag for class detection
    if (trimmed.startsWith("<?php")) trimmed = trimmed.replace(/^<\?php\s*/, "");
    // skip comment lines, but let preprocessor imports (#include/#import/#require) through
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("#") && !/^#\s*(include|import|require)\b/.test(trimmed)) continue;
    if (SKIP_START.test(trimmed)) continue;

    const isTest = isTestFile || /^(test|spec|Test)/.test(trimmed);
    const name = declList.reduce<string | null>((acc, re) => acc ?? matchName(trimmed, re), null);
    if (name) {
      const kind = rgKindFromLine(trimmed);
      const s = addSym(ctx, lineNode(i, line), kind, "heuristic", {
        exported: name[0] !== "_",
        test: isTest,
      });
      s.name = name;
      continue;
    }

    for (const re of RG_IMPORT_RES) {
      const m = re.exec(trimmed);
      if (m) {
        const module = m[1];
        const imp = addSym(ctx, lineNode(i, line), "import", "heuristic", { sig: `import ${module}` });
        imp.name = module.split(/[./]/).pop() || module;
        ctx.imports.push({ file: ctx.file, module, local: imp.name, at: `${ctx.file}:${i + 1}` });
        ctx.edges.push({ from: imp.id, to: "", name: imp.name, kind: "import", conf: "heuristic", at: `${ctx.file}:${i + 1}` });
        break;
      }
    }
  }

  promoteKinds(ctx, { isEntry, isConfig });
}
