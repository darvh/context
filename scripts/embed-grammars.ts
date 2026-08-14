import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const dest = path.join(root, "spike", "grammars");
const pkgs: Record<string, string[]> = {
  "tree-sitter-go": ["tree-sitter-go.wasm"],
  "tree-sitter-python": ["tree-sitter-python.wasm"],
  "tree-sitter-typescript": ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  "tree-sitter-javascript": ["tree-sitter-javascript.wasm"],
  "tree-sitter-java": ["tree-sitter-java.wasm"],
  "tree-sitter-ruby": ["tree-sitter-ruby.wasm"],
  "tree-sitter-rust": ["tree-sitter-rust.wasm"],
  "tree-sitter-c": ["tree-sitter-c.wasm"],
  "tree-sitter-cpp": ["tree-sitter-cpp.wasm"],
  "tree-sitter-c-sharp": ["tree-sitter-c_sharp.wasm"],
  "tree-sitter-php": ["tree-sitter-php.wasm"],
  "tree-sitter-bash": ["tree-sitter-bash.wasm"],
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

// web-tree-sitter 0.25 base runtime wasm, needed at Parser.init() time
const base = path.join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
const baseOut = path.join(dest, "web-tree-sitter");
await fs.mkdir(baseOut, { recursive: true });
await fs.copyFile(base, path.join(baseOut, "tree-sitter.wasm"));
console.log("embedded web-tree-sitter base wasm");
