import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Deterministic large-repo fixture generator. No live downloads: content is
 * seeded, so CI and laptops build the identical corpus. Exercises what a small
 * fixture cannot: many files (parse cost), long multi-section documents
 * (section indexing), and one dense file (adversarial parse cost).
 *
 *   bun run eval/gen-fixture.ts                 # small -> var/large-fixture
 *   bun run eval/gen-fixture.ts --size medium|large --seed 7 --out DIR
 *
 * Output layout:
 *   <out>/code/<mod>.{go,ts,py}   20+15+12 symbols per module
 *   <out>/docs/<mod>.md           one long document (~60 sections, unique terms)
 *   <out>/dense/blob.go           one adversarial dense file
 *   <out>/manifest.json           seed, size, counts (corpus manifest)
 */

const args = process.argv.slice(2);
const sizeArg = args.find((a) => a.startsWith("--size="))?.split("=")[1] ?? (() => {
  const i = args.indexOf("--size");
  return i >= 0 ? args[i + 1] : "small";
})() ?? "small";
const seedArg = Number(args.find((a) => a.startsWith("--seed="))?.split("=")[1] ?? 7);
const outArg = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : undefined;
})();

const SIZES: Record<string, { modules: number; docSections: number; docLines: number }> = {
  small: { modules: 100, docSections: 40, docLines: 900 },
  medium: { modules: 400, docSections: 60, docLines: 1400 },
  large: { modules: 1200, docSections: 80, docLines: 1900 },
};
const cfg = SIZES[sizeArg] ?? SIZES.small;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["session", "cache", "auth", "billing", "search", "queue", "worker", "metrics", "storage", "sync", "parser", "render", "retry", "lease", "quota", "throttle", "probe", "delta", "snapshot", "registry"];

function words(rng: () => number, n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(WORDS[Math.floor(rng() * WORDS.length)] + (Math.floor(rng() * 900) + 1));
  return [...out];
}

const outDir = path.resolve(outArg ?? path.join(import.meta.dir, "..", "var", "large-fixture", `${sizeArg}-${seedArg}`));
const rng = mulberry32(seedArg);
let files = 0;
let docs = 0;

await fs.rm(outDir, { recursive: true, force: true });

for (let i = 0; i < cfg.modules; i++) {
  const mod = `m${i}`;
  const terms = words(rng, 3);
  // go: 20 funcs with doc comments
  let go = `package m${i}\n\nimport "errors"\n\n`;
  for (let j = 0; j < 20; j++) go += `// ${terms[0]} ${terms[1]} operation ${j}.\nfunc Op${j}(key string) (string, error) { return "", errors.New("x") }\n\n`;
  await fs.mkdir(path.join(outDir, "code"), { recursive: true });
  await fs.writeFile(path.join(outDir, `code/${mod}.go`), go);
  // ts: 15 exported funcs
  let ts = `// ${terms[0]} module.\n`;
  for (let j = 0; j < 15; j++) ts += `export function op${j}(key: string): Promise<string | null> { return Promise.resolve(null); }\n\n`;
  await fs.writeFile(path.join(outDir, `code/${mod}.ts`), ts);
  // py: 12 defs with docstrings
  let py = `"""${terms[1]} module."""\n`;
  for (let j = 0; j < 12; j++) py += `def op${j}(key: str) -> str | None:\n    """${terms[1]} ${terms[2]} record."""\n    return None\n\n`;
  await fs.writeFile(path.join(outDir, `code/${mod}.py`), py);

  // long document: ~cfg.docSections sections, unique terms per section
  await fs.mkdir(path.join(outDir, "docs"), { recursive: true });
  let md = `# ${mod} guide\n\n`;
  for (let s = 0; s < cfg.docSections; s++) {
    const sectionWords = words(rng, 5);
    md += `## Section ${s}: ${sectionWords.join(" ")}\n\n`;
    for (let l = 0; l < Math.floor(cfg.docLines / cfg.docSections); l++) {
      md += `${sectionWords[0]} ${sectionWords[1]} ${sectionWords[2]} ${sectionWords[3]} sentence ${l} with ${sectionWords[4]} details and configuration defaults.\n\n`;
    }
  }
  await fs.writeFile(path.join(outDir, `docs/${mod}.md`), md);

  files += 3;
  docs++;
}

// one adversarial dense file: many near-duplicate symbols
let blob = "package blob\n\n";
for (let i = 0; i < 1200; i++) blob += `// BlobItem${i} does a ${WORDS[i % WORDS.length]} thing.\nfunc BlobItem${i}(k string) error { return nil }\n\n`;
await fs.mkdir(path.join(outDir, "dense"), { recursive: true });
await fs.writeFile(path.join(outDir, "dense/blob.go"), blob);
files++;

const manifest = {
  seed: seedArg,
  size: sizeArg,
  modules: cfg.modules,
  docSections: cfg.docSections,
  codeFiles: files,
  docFiles: docs,
  version: "fixture-v1",
  generatedAt: new Date().toISOString(),
};
await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`fixture: ${sizeArg} seed=${seedArg} -> ${outDir} (${files} code files, ${docs} long docs, ${cfg.modules} modules)`);
