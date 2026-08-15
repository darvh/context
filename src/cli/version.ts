import pkg from "../../package.json" with { type: "json" };
import { CACHE_VERSION } from "../core/cache";

/** Bun-compiled binaries run from the embedded $bunfs filesystem; the source
 * runtime runs from a real checkout. */
export function runtimeKind(): "compiled" | "source" {
  return import.meta.dir?.startsWith("/$bunfs") ? "compiled" : "source";
}

async function gitHead(): Promise<string | null> {
  try {
    const p = Bun.spawn({ cmd: ["git", "rev-parse", "--short", "HEAD"], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

let memo: string | null = null;

/** Build identity: version, build commit, cache schema, runtime kind. */
export async function buildInfo(): Promise<string> {
  if (memo) return memo;
  const { BUILD_ID } = await import("./build-id");
  const git = BUILD_ID !== "dev" ? BUILD_ID : (await gitHead()) ?? "unknown";
  memo = `context ${pkg.version} (build ${git}, cache-schema ${CACHE_VERSION}, runtime ${runtimeKind()})`;
  return memo;
}
