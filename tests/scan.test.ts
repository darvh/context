import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scan } from "../src/scan";

const tmp = () => path.join(import.meta.dir, "..", "var", "scan-" + Date.now() + "-" + Math.random().toString(36).slice(2));

async function setup() {
  const root = tmp();
  await fs.mkdir(path.join(root, "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "vendor"), { recursive: true });
  await fs.writeFile(path.join(root, "lib", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "lib", "a.min.js"), "var a=1;\n");
  await fs.writeFile(path.join(root, "vendor", "b.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(root, ".gitignore"), "*.min.js\nvendor/\n");
  return root;
}

describe("scan ignore override", () => {
  test("does not include symbolic links", async () => {
    const root = await setup();
    try {
      await fs.symlink("/etc/hosts", path.join(root, "lib", "external.ts"));
      expect((await scan(root)).files).not.toContain("lib/external.ts");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("defaults respect gitignore", async () => {
    const root = await setup();
    try {
      const f = (await scan(root)).files;
      expect(f).toContain("lib/a.ts");
      expect(f).not.toContain("lib/a.min.js");
      expect(f).not.toContain("vendor/b.ts");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("--no-gitignore includes gitignored files but keeps defaults", async () => {
    const root = await setup();
    try {
      const f = (await scan(root, { noGitignore: true })).files;
      expect(f).toContain("lib/a.min.js");
      expect(f).toContain("vendor/b.ts");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("--ignore adds patterns on top of gitignore", async () => {
    const root = await setup();
    try {
      const f = (await scan(root, { ignore: ["lib/a.ts"] })).files;
      expect(f).not.toContain("lib/a.ts");
      expect(f).not.toContain("lib/a.min.js"); // gitignore still applies
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
