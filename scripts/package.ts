import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const source = path.join(root, "spike", "grammars");
const destination = path.join(root, "dist", "grammars");

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.cp(source, destination, { recursive: true });
console.log(`packaged grammars -> ${path.relative(root, destination)}`);

// compiled binaries cannot serve scripts from $bunfs: hook adapters ship next
// to the binary (context/dist/context + context/scripts) so `context init`
// writes real hook commands
const scriptsDest = path.join(root, "dist", "scripts");
await fs.rm(scriptsDest, { recursive: true, force: true });
await fs.mkdir(scriptsDest, { recursive: true });
await fs.cp(path.join(root, "scripts", "hook-user.ts"), path.join(scriptsDest, "hook-user.ts"));
await fs.cp(path.join(root, "scripts", "hook-agent.ts"), path.join(scriptsDest, "hook-agent.ts"));
await fs.cp(path.join(root, "scripts", "hook-session.ts"), path.join(scriptsDest, "hook-session.ts"));
console.log(`packaged hook scripts -> ${path.relative(root, scriptsDest)}`);
