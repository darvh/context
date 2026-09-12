import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..", "..");
const dist = path.join(root, "dist");
const vendor = path.join(root, "vendor", "onnxruntime-node");
const isNative = (f: string) => f.endsWith(".dylib") || f.includes(".so") || f.endsWith(".dll");

await fs.mkdir(dist, { recursive: true });

// the onnxruntime runtime library must sit BESIDE the binary (dyld/ld.so
// resolve it via @executable_path/$ORIGIN; embedded bunfs paths cannot be
// dlopen'd). Remove previously staged libs first so a target switch never
// leaves the wrong runtime behind.
for (const f of await fs.readdir(dist)) {
  if (isNative(f)) await fs.rm(path.join(dist, f), { force: true });
}

const libs = (await fs.readdir(vendor).catch(() => [])).filter(isNative);
for (const f of libs) await fs.copyFile(path.join(vendor, f), path.join(dist, f));
console.log(`packaged onnxruntime runtime libs -> dist/: ${libs.join(", ") || "(none)"}`);
console.log("grammars + skill are embedded in the binary (--asset)");
