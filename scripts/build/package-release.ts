import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Assemble the release tree for one target, sign it on macOS, and produce a
 *  ZIP + SHA-256. Cross-platform: on Windows bsdtar writes the zip (zip.exe is
 *  not installed), everywhere else zip(1). Run after the target binary has been
 *  compiled to release/context/dist/context<ext>. */

const root = path.join(import.meta.dir, "..", "..");
const argv = process.argv.slice(2);
const get = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
};
const tag = get("tag");
const asset = get("asset");
const ext = get("ext");
if (!tag || !asset) {
  console.error("usage: package-release.ts --tag vX.Y.Z --asset linux-x64 [--ext .exe]");
  process.exit(2);
}

const releaseDir = path.join(root, "release");
const rel = path.join(releaseDir, "context");
const relDist = path.join(rel, "dist");
const binary = `context${ext}`;
const exists = (p: string) => fs.stat(p).then(() => true).catch(() => false);

if (!(await exists(path.join(relDist, binary)))) {
  console.error(`package-release: missing ${path.join(relDist, binary)} (build the target binary first)`);
  process.exit(1);
}

// runtime libs beside the binary
const dist = path.join(root, "dist");
const isNative = (f: string) => f.endsWith(".dylib") || f.includes(".so") || f.endsWith(".dll");
for (const f of await fs.readdir(dist).catch(() => [])) {
  if (isNative(f)) await fs.copyFile(path.join(dist, f), path.join(relDist, f));
}

// skill + source fallback + manifests
const keep = (p: string) => path.basename(p) !== ".DS_Store";
await fs.rm(path.join(rel, "skill"), { recursive: true, force: true });
await fs.cp(path.join(root, "skills", "context"), path.join(rel, "skill"), { recursive: true, filter: keep });
await fs.cp(path.join(root, "src"), path.join(rel, "src"), { recursive: true, filter: keep });
await fs.cp(path.join(root, "scripts"), path.join(rel, "scripts"), { recursive: true, filter: keep });
for (const f of ["package.json", "bun.lock"]) await fs.copyFile(path.join(root, f), path.join(rel, f));

// macOS: ad-hoc sign so dyld accepts the compiled binary (bun build output is
// otherwise rejected and SIGKILLed at launch). Works for a cross-compiled x64
// binary on an arm64 runner too.
if (process.platform === "darwin") {
  const r = spawnSync("codesign", ["--force", "--sign", "-", path.join(relDist, binary)], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("package-release: codesign failed");
    process.exit(1);
  }
}

const zipPath = path.join(root, `context-${tag}-${asset}.zip`);
await fs.rm(zipPath, { force: true });
const zipped =
  process.platform === "win32"
    ? spawnSync("tar", ["-a", "-c", "-f", zipPath, "-C", releaseDir, "context"], { stdio: "inherit" })
    : spawnSync("zip", ["-rq", zipPath, "context"], { cwd: releaseDir, stdio: "inherit" });
if (zipped.error || zipped.status !== 0) {
  console.error("package-release: zip failed", zipped.error?.message ?? zipped.status);
  process.exit(1);
}

const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(zipPath).arrayBuffer()).digest("hex");
await fs.writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
console.log(`package-release: ${path.basename(zipPath)} (${hash})`);
