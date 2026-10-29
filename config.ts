import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Optional per-machine settings in <Pi agent dir>/pi-jev-compact.json. A missing file means defaults.
export const CONFIG_FILE = "pi-jev-compact.json";
const DEFAULTS = Object.freeze({ stripThinkingModels: [], typesafeApiKeyFile: undefined });
const expand = path => path.replace(/^~(?=\/|$)/, homedir());

export function loadConfig(agentDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8")); }
  catch (error) {
    // A broken file must not disable Pi: report it and keep defaults.
    return error?.code === "ENOENT" ? { ...DEFAULTS } : { ...DEFAULTS, error: `${CONFIG_FILE}: ${error.message}` };
  }
  return {
    stripThinkingModels: Array.isArray(raw?.stripThinkingModels) ? raw.stripThinkingModels.filter(p => typeof p === "string") : [],
    typesafeApiKeyFile: typeof raw?.typesafeApiKeyFile === "string" ? expand(raw.typesafeApiKeyFile) : undefined,
  };
}

// The environment wins; the key file is read on demand so a rotated key needs no reload.
export function resolveKey(config, env = process.env) {
  if (env.TYPESAFE_API_KEY) return { key: env.TYPESAFE_API_KEY, source: "env" };
  if (!config.typesafeApiKeyFile) return { key: undefined, source: "none" };
  try {
    const key = readFileSync(config.typesafeApiKeyFile, "utf8").trim();
    return { key: key || undefined, source: key ? "file" : "file_empty" };
  } catch { return { key: undefined, source: "file_unreadable" }; }
}

// Patterns are "provider/model-id"; "*" matches any run of characters.
export function modelMatches(patterns, model) {
  if (!model) return false;
  const name = `${model.provider}/${model.id}`;
  return patterns.some(p => new RegExp(`^${p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name));
}
