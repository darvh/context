import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const dest = path.join(root, "spike", "grammars");
const pkgs: Record<string, string[]> = {
  "tree-sitter-go": ["tree-sitter-go.wasm"],
  "tree-sitter-python": ["tree-sitter-python.wasm"],
  "tree-sitter-typescript": ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  "tree-sitter-javascript": ["tree-sitter-javascript.wasm"],
};

for (const [pkg, files] of Object.entries(pkgs)) {
  for (const f of files) {
    const src = path.join(root, "node_modules", pkg, f);
    const outDir = path.join(dest, pkg);
    await fs.mkdir(outDir, { recursive: true });
    await fs.copyFile(src, path.join(outDir, f));
  }
  console.log("embedded", pkg);
}
