import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Vendor the platform-specific onnxruntime native binding + runtime library
 *  into vendor/onnxruntime-node/ so the tsconfig paths mapping serves it to
 *  both `bun run` (source) and `bun build --compile` (embedded .node), with
 *  the dylib found via @executable_path on macOS. Deterministic, no network. */

const root = path.join(import.meta.dir, "..");
const src = path.join(root, "node_modules", "onnxruntime-node", "bin", "napi-v6", process.platform, process.arch);
const dst = path.join(root, "vendor", "onnxruntime-node");
const lib = process.platform === "darwin" ? "libonnxruntime.1.24.3.dylib" : process.platform === "linux" ? "libonnxruntime.so.1" : null;

await fs.mkdir(dst, { recursive: true });
const copied: string[] = [];
for (const f of ["onnxruntime_binding.node", ...(lib ? [lib] : [])]) {
  try {
    await fs.copyFile(path.join(src, f), path.join(dst, f));
    copied.push(f);
  } catch {
    if (f === "onnxruntime_binding.node") throw new Error(`onnxruntime binding not found for ${process.platform}/${process.arch}`);
  }
}
console.log(`vendored onnxruntime (${process.platform}/${process.arch}): ${copied.join(", ")}`);

// macOS: add @executable_path rpath so the dylib resolves beside the binary
if (process.platform === "darwin") {
  const node = path.join(dst, "onnxruntime_binding.node");
  const check = spawnSync("otool", ["-l", node], { encoding: "utf8" });
  if (!check.stdout.includes("@executable_path")) {
    const r = spawnSync("install_name_tool", ["-add_rpath", "@executable_path", node]);
    if (r.status !== 0) console.error("install_name_tool failed (non-fatal):", r.stderr?.toString());
  }
}
