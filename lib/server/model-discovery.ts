import { spawn, execFile } from "node:child_process";
import os from "node:os";
import { query, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DiscoveryError } from "./discovery-error";
import { normalizeChoice, normalizeModelLabel, REASONING_LABELS, type ModelChoice, type ModelProvider, type ReasoningEffort } from "../models";

export const DISCOVERY_TIMEOUT_MS = 12_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const efforts = (values: unknown): ReasoningEffort[] => Array.isArray(values)
  ? [...new Set(values.filter((v): v is ReasoningEffort => typeof v === "string" && Object.hasOwn(REASONING_LABELS, v)))]
  : [];

/** The models a provider offers depend on the version of the tool that asks,
 * so discovery reports that version beside what it found. */
export interface Discovery { models: ModelChoice[]; version?: string }

export function parseCodexModels(data: unknown): ModelChoice[] {
  if (!Array.isArray(data)) throw new DiscoveryError("returned an unreadable response");
  return data.flatMap((row) => {
    if (!row || typeof row.model !== "string" || !row.model.trim() || row.hidden === true) return [];
    const reasoningEfforts = efforts(row.supportedReasoningEfforts?.map((e: { reasoningEffort?: unknown }) => e?.reasoningEffort));
    const name = typeof row.displayName === "string" && row.displayName ? row.displayName : row.model;
    return [normalizeChoice({ value: row.model, label: name,
      provider: "codex" as const, reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.find((e) => e === row.defaultReasoningEffort) })];
  });
}

/** Public app-server RPC only: no thread, turn, prompt, or credential reading. */
export function discoverCodex(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<Discovery> {
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
    let version: string | undefined;
    const cursors = new Set<string>();
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGKILL");
      if (error) reject(error); else resolve({ models, version });
    };
    const timer = setTimeout(() => finish(new DiscoveryError("timed out")), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(new DiscoveryError("is not installed")));
    child.on("exit", () => finish(new DiscoveryError("stopped before answering")));
    child.stdin.on("error", () => finish(new DiscoveryError("stopped before answering")));
    child.stderr.resume(); // Never expose CLI diagnostics (which may contain account details).
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return finish(new DiscoveryError("returned too much data"));
      buffer += chunk;
      let newline: number;
      while (!done && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          if (message.error) return finish(new DiscoveryError("rejected the request"));
          if (stage === "initialize") {
            stage = "models";
            // `autoproject/0.160.0 (...)`: the name we sent, then Codex's own version.
            version = /^\S+\/(\d[\w.+-]*)/.exec(String(message.result?.userAgent ?? ""))?.[1];
            send({ method: "initialized" });
            send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: false } });
          } else {
            models.push(...parseCodexModels(message.result?.data));
            const cursor = message.result?.nextCursor;
            if (cursor == null) return finish();
            if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 20) {
              return finish(new DiscoveryError("returned an unreadable response"));
            }
            cursors.add(cursor);
            send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
          }
        } catch { finish(new DiscoveryError("returned an unreadable response")); }
      }
    });
    send({ id, method: "initialize", params: { clientInfo: { name: "autoproject", title: "AutoProject", version: "0.1.0" }, capabilities: null } });
  });
}

/** The SDK's displayName is bare ("Opus"); the version sits at the head of the
 * description ("Opus 5.5 · Best for everyday tasks"). Prefer that when it
 * actually names one, so Claude reads like the other two providers. */
function claudeLabel(row: ModelInfo): string {
  const head = row.description?.split("\u00b7")[0]?.trim() ?? "";
  const named = normalizeModelLabel(head);
  return /\d/.test(named) ? named : row.displayName || row.value;
}

export function parseClaudeModels(rows: ModelInfo[]): ModelChoice[] {
  // `opus` always means the newest Opus, so a saved alias follows each release
  // by itself. Keep the alias and drop the pinned ID it currently points at.
  const aliased = new Set(rows.filter((r) => r.value !== "default" && r.resolvedModel !== r.value).map((r) => r.resolvedModel));
  return rows.flatMap((row) => {
    // "default" is an alias for another listed model, not a model of its own.
    if (!row.value?.trim() || row.value === "default" || aliased.has(row.value)) return [];
    return [normalizeChoice({ value: row.value, label: claudeLabel(row),
      provider: "claude" as const,
      reasoningEfforts: row.supportsEffort === false ? [] : efforts(row.supportedEffortLevels) })];
  });
}

export async function discoverClaude(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<Discovery> {
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
      session.supportedModels().then((rows) => ({ models: parseClaudeModels(rows) })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DiscoveryError("timed out")), timeoutMs); }),
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
    const match = /^(gemini-[^\t]+)\t+(.+)$/.exec(line.trim());
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
      label, provider: "gemini",
      reasoningEfforts, reasoningModels, defaultReasoningEffort: reasoningEfforts.at(-1) });
  }
  return [...groups.values()].map(normalizeChoice);
}

function agy(args: string[], timeoutMs: number): Promise<string> {
  const executable = process.env.AUTOPROJECT_AGY_PATH?.trim() || process.env.AUTOPROJECT_GEMINI_PATH?.trim() || "agy";
  return new Promise((resolve, reject) => {
    execFile(/* turbopackIgnore: true */ executable, args, {
      cwd: os.homedir(), env: process.env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    }, (error, stdout) => error
      ? reject(new DiscoveryError(error.code === "ENOENT" ? "is not installed" : error.killed ? "timed out" : "failed to answer"))
      : resolve(stdout));
  });
}

export async function discoverGemini(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<Discovery> {
  const [models, version] = await Promise.all([
    agy(["models"], timeoutMs).then(parseGeminiModels),
    // Only ever a footnote to the models: never fail the refresh over it.
    agy(["--version"], timeoutMs).then((out) => /\d[\w.+-]*/.exec(out)?.[0], () => undefined),
  ]);
  return { models, version };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const step = (a[i] ?? 0) - (b[i] ?? 0);
    if (step) return step > 0;
  }
  return false;
}

/** The tools list every release they still accept. Keep the newest of each
 * family and drop the rest. Labels are already normalised to "family version"
 * (Opus 5.5, Sol 6.1, Flash 3.8) whatever shape each provider gives its IDs,
 * so they are where every provider agrees on what a family and a version are.
 * A label with no version is its own family. Saved selections this hides stay
 * visible and routable through the retained history. */
export function latestPerFamily(models: ModelChoice[]): ModelChoice[] {
  const latest = new Map<string, { model: ModelChoice; version: number[] }>();
  for (const model of models) {
    const match = /^(.+) (\d+(?:\.\d+)*)$/.exec(model.label);
    const family = match ? match[1] : `\0${model.value}`;
    const version = match ? match[2].split(".").map(Number) : [];
    const best = latest.get(family);
    if (!best || newer(version, best.version)) latest.set(family, { model, version });
  }
  return [...latest.values()].map(({ model }) => model);
}

const newest = (discover: () => Promise<Discovery>) => async (): Promise<Discovery> => {
  const found = await discover();
  return { ...found, models: latestPerFamily(found.models) };
};

export const discoverers: Record<ModelProvider, () => Promise<Discovery>> = {
  codex: newest(discoverCodex), claude: newest(discoverClaude), gemini: newest(discoverGemini),
};
