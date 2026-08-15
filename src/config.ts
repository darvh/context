import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { writeJson } from "./cache";

/**
 * User-level configuration (~/.config/context/config.json, honors XDG_CONFIG_HOME).
 * Never written into a repository (plan invariant). `context config` commands
 * read and update it.
 */
export interface ContextConfig {
  /** enable the optional semantic fallback */
  semantic?: boolean;
  /** local embedding model override */
  model?: string;
}

export const CONFIG_KEYS = ["semantic", "model"] as const;

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir(), ".config");
  return path.join(base, "context");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function readConfig(): Promise<ContextConfig> {
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8")) as ContextConfig;
  } catch {
    return {};
  }
}

export async function setConfig(key: string, value: string): Promise<ContextConfig> {
  const cfg = await readConfig();
  if (key === "semantic") {
    cfg.semantic = ["on", "true", "1", "yes"].includes(value.toLowerCase());
  } else if (key === "model") {
    cfg.model = value;
  } else {
    throw new Error(`unknown config key "${key}" (known: ${CONFIG_KEYS.join(", ")})`);
  }
  await writeJson(configPath(), cfg);
  return cfg;
}
