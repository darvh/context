#!/usr/bin/env bun
import { runHook } from "../src/hook";

const task = process.argv.slice(2).join(" ") || "";
await runHook(task, process.cwd());
