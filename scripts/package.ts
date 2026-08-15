import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const destination = path.join(root, "dist", "grammars");

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(path.dirname(destination), { recursive: true });

// the onnxruntime runtime library must sit BESIDE the binary (dyld resolves
// @executable_path; embedded bunfs paths cannot be dlopen'd)
const libName = process.platform === "darwin" ? "libonnxruntime.1.24.3.dylib" : process.platform === "linux" ? "libonnxruntime.so.1" : null;
if (libName) {
  const lib = path.join(root, "vendor", "onnxruntime-node", libName);
  await fs.copyFile(lib, path.join(root, "dist", libName)).catch(() => {});
  console.log(`packaged runtime lib -> dist/${libName}`);
}
console.log("grammars + skill are embedded in the binary (--asset)");
