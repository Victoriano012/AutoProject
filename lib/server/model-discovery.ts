import { spawn, execFile } from "node:child_process";
import os from "node:os";
import { query, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { REASONING_LABELS, type ModelChoice, type ModelProvider, type ReasoningEffort } from "../models";

export const DISCOVERY_TIMEOUT_MS = 12_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const efforts = (values: unknown): ReasoningEffort[] => Array.isArray(values)
  ? [...new Set(values.filter((v): v is ReasoningEffort => typeof v === "string" && Object.hasOwn(REASONING_LABELS, v)))]
  : [];

export function parseCodexModels(data: unknown): ModelChoice[] {
  if (!Array.isArray(data)) throw new Error("Invalid Codex catalog");
  return data.flatMap((row) => {
    if (!row || typeof row.model !== "string" || !row.model.trim() || row.hidden === true) return [];
    const reasoningEfforts = efforts(row.supportedReasoningEfforts?.map((e: { reasoningEffort?: unknown }) => e?.reasoningEffort));
    return [{ value: row.model, label: typeof row.displayName === "string" ? row.displayName : row.model,
      provider: "codex" as const, reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.find((e) => e === row.defaultReasoningEffort) }];
  });
}

/** Public app-server RPC only: no thread, turn, prompt, or credential reading. */
export function discoverCodex(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<ModelChoice[]> {
  return new Promise((resolve, reject) => {
    const executable = process.env.AUTOPROJECT_CODEX_PATH?.trim() || "codex";
    const child = spawn(/* turbopackIgnore: true */ executable, ["app-server"], {
      cwd: os.homedir(), env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    let buffer = "";
    let bytes = 0;
    let id = 1;
    let stage: "initialize" | "models" = "initialize";
    const models: ModelChoice[] = [];
    const cursors = new Set<string>();
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGKILL");
      if (error) reject(error); else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error("Codex discovery timed out")), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(new Error("Codex could not start")));
    child.on("exit", () => finish(new Error("Codex exited before discovery completed")));
    child.stdin.on("error", () => finish(new Error("Codex discovery connection closed")));
    child.stderr.resume(); // Never expose CLI diagnostics (which may contain account details).
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return finish(new Error("Codex catalog exceeded size limit"));
      buffer += chunk;
      let newline: number;
      while (!done && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          if (message.error) return finish(new Error("Codex discovery request failed"));
          if (stage === "initialize") {
            stage = "models";
            send({ method: "initialized" });
            send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: false } });
          } else {
            models.push(...parseCodexModels(message.result?.data));
            const cursor = message.result?.nextCursor;
            if (cursor == null) return finish();
            if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 20) {
              return finish(new Error("Invalid Codex pagination"));
            }
            cursors.add(cursor);
            send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
          }
        } catch { finish(new Error("Invalid Codex discovery response")); }
      }
    });
    send({ id, method: "initialize", params: { clientInfo: { name: "autoproject", title: "AutoProject", version: "0.1.0" }, capabilities: null } });
  });
}

export function parseClaudeModels(rows: ModelInfo[]): ModelChoice[] {
  return rows.flatMap((row) => {
    if (!row.value?.trim()) return [];
    const choice: ModelChoice = { value: row.value, label: row.displayName || row.value, provider: "claude",
      reasoningEfforts: row.supportsEffort === false ? [] : efforts(row.supportedEffortLevels) };
    return row.resolvedModel && row.resolvedModel !== row.value
      ? [choice, { ...choice, value: row.resolvedModel, label: `${choice.label} (${row.resolvedModel})` }]
      : [choice];
  });
}

export async function discoverClaude(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<ModelChoice[]> {
  const abortController = new AbortController();
  let endInput = () => {};
  // Keep stdin open without ever submitting a user message or starting inference.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => { endInput = resolve; });
  }
  const session = query({ prompt: input(), options: {
    cwd: os.homedir(), settingSources: ["project"], persistSession: false,
    abortController, tools: [], mcpServers: {},
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.supportedModels().then(parseClaudeModels),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude discovery timed out")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    endInput();
    session.close();
    abortController.abort();
  }
}

/** agy exposes a tab-separated catalog, including non-Gemini models. Only
 * Gemini IDs belong to this integration; Claude stays with the Claude SDK. */
export function parseGeminiModels(output: string): ModelChoice[] {
  const groups = new Map<string, ModelChoice>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(gemini-[\w.-]+)\t+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, value, label] = match;
    const variant = /-(low|medium|high)$/.exec(value);
    if (!variant) { groups.set(value, { value, label, provider: "gemini", reasoningEfforts: [] }); continue; }
    const base = value.slice(0, -variant[0].length);
    const effort = variant[1] as ReasoningEffort;
    const previous = groups.get(base);
    const reasoningModels = { ...previous?.reasoningModels, [effort]: value };
    const reasoningEfforts = (["low", "medium", "high"] as const).filter((e) => reasoningModels[e]);
    groups.set(base, { value: reasoningModels.high ?? previous?.value ?? value,
      label: label.replace(/\s*\((Low|Medium|High)\)$/, ""), provider: "gemini",
      reasoningEfforts, reasoningModels, defaultReasoningEffort: reasoningEfforts.at(-1) });
  }
  return [...groups.values()];
}

export function discoverGemini(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<ModelChoice[]> {
  const executable = process.env.AUTOPROJECT_AGY_PATH?.trim() || process.env.AUTOPROJECT_GEMINI_PATH?.trim() || "agy";
  return new Promise((resolve, reject) => {
    execFile(/* turbopackIgnore: true */ executable, ["models"], {
      cwd: os.homedir(), env: process.env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    }, (error, stdout) => error ? reject(new Error("Gemini discovery failed")) : resolve(parseGeminiModels(stdout)));
  });
}

export const discoverers: Record<ModelProvider, () => Promise<ModelChoice[]>> = {
  codex: discoverCodex, claude: discoverClaude, gemini: discoverGemini,
};
