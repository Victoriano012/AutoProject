import fs from "fs";
import { randomUUID } from "node:crypto";
import os from "os";
import path from "path";
import { DEFAULT_MODEL, resolveReasoningEffort, type ReasoningEffort } from "./models";

/** App-wide settings, shared by every project. */
const CONFIG = path.join(os.homedir(), ".autoproject", "config.json");

export interface AppConfig {
  /** Model override for the AI agents; unset = `DEFAULT_MODEL`. */
  model?: string;
  /** Defaults to High for models with a supported effort control. */
  reasoningEffort?: ReasoningEffort;
}

/** Resolve saved settings once for a turn, including older config files. */
export function selectedAgentSettings(modelOverride?: string) {
  const config = readConfig();
  const model = modelOverride ?? (config.model || DEFAULT_MODEL);
  return { model, reasoningEffort: resolveReasoningEffort(model, config.reasoningEffort) };
}

export function readConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config: AppConfig) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const temporary = `${CONFIG}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, CONFIG);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** The configured model, shared by every agent entry point. */
export function selectedModel(): string {
  return readConfig().model || DEFAULT_MODEL;
}
