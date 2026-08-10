#!/usr/bin/env bun
import { runHook } from "./hook";

const task = process.argv.slice(2).join(" ") || "";
await runHook(task, process.cwd());
