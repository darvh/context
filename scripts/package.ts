import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const source = path.join(root, "spike", "grammars");
const destination = path.join(root, "dist", "grammars");

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.cp(source, destination, { recursive: true });
console.log(`packaged grammars -> ${path.relative(root, destination)}`);
