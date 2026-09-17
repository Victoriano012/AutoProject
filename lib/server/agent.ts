import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type ModelUsage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import { resumableSession, tagSession } from "../agent-session";
import { type AttachmentPayload, writeAttachments } from "../attachments";
import { selectedModel } from "../config";
import { providerForModel } from "../models";
import { streamCodexAgent } from "./codex";
import { streamGeminiAgent } from "./gemini";

/** What one agent session cost, as the provider reported it. Nothing is
 * modelled here: a provider that gives no cost figure (the Codex CLI gives
 * tokens only) leaves `costUsd` absent rather than being priced from a table. */
export interface RunUsage {
  tokens: number;
  costUsd?: number;
}

/** One agent turn, as the ticket runner consumes it. */
export type AgentEvent =
  | { type: "init"; sessionId: string }
  /** Claude only, before init: `push` hands a follow-up message to the running
   * turn, which the model sees with its next tool result; false once the turn
   * is over and the message must wait for a new one. */
  | { type: "input"; push: (text: string) => boolean }
  /** `sub`: produced inside a subagent (act mode), so a transcript can indent it. */
  | { type: "text"; text: string; sub?: boolean }
  | { type: "tool"; text: string; sub?: boolean }
  /** Claude only: the main agent started a subagent (an Agent tool call), and
   * that call came back. */
  | { type: "subagent"; id: string; description: string; agentType?: string }
  | { type: "subagent-end"; id: string }
  | {
      type: "result";
      ok: boolean;
      text: string;
      structuredOutput?: unknown;
      usage?: RunUsage;
    }
  | { type: "error"; message: string };

export interface AgentRequest {
  workspaceDir?: string;
  prompt: string;
  sessionId?: string;
  attachments?: AttachmentPayload[];
  signal: AbortSignal;
  /** Capture once at the start when prompt construction also depends on it. */
  model?: string;
  /** Ticket work and side chat may edit; planners remain read-only. */
  writeAccess?: boolean;
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
  // ---- project agent only; the Codex and Gemini CLIs ignore these ----
  /** Appended to the claude_code preset system prompt (the agent's standing role). */
  systemPromptAppend?: string;
  /** In-process MCP servers; every tool they expose is allowed. */
  mcpServers?: Record<string, McpServerConfig>;
  disallowedTools?: string[];
  /** Subagents the Agent tool may start. */
  agents?: Record<string, AgentDefinition>;
  /** Forward subagent text too, not just their tool calls. */
  forwardSubagentText?: boolean;
  /** Keep the CLI from backgrounding shells and subagents (see the env below). */
  disableBackgroundTasks?: boolean;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  structuredOutput?: unknown;
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail =
    (i.file_path as string) ??
    (i.command as string) ??
    (i.pattern as string) ??
    (i.url as string) ??
    // The Agent tool: what the subagent was asked to do.
    (i.description as string) ??
    "";
  return detail ? `${name}: ${String(detail).slice(0, 200)}` : name;
}

function workspaceDir(requested?: string): string {
  return (
    requested?.trim() ||
    process.env.AUTOPROJECT_WORKSPACE ||
    path.join(os.tmpdir(), "autoproject-workspace")
  );
}

function promptWithAttachments(
  cwd: string,
  prompt: string,
  attachments?: AttachmentPayload[]
): string {
  if (!attachments?.length) return prompt;
  const files = writeAttachments(
    path.join(cwd, ".autoproject", "attachments"),
    attachments
  );
  return (
    `Reference files attached to this ticket or inherited from parent tickets (read them when relevant):\n` +
    files.map((file) => `- ${file}`).join("\n") +
    `\n\n${prompt}`
  );
}

/** Run one agent session through the CLI that owns the selected model. */
export async function* streamAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const cwd = workspaceDir(req.workspaceDir);
  fs.mkdirSync(cwd, { recursive: true });
  const model = req.model ?? selectedModel();
  const prompt = promptWithAttachments(cwd, req.prompt, req.attachments);
  const prepared = { ...req, workspaceDir: cwd, prompt, model };

  const provider = providerForModel(model);
  if (provider === "codex") {
    yield* streamCodexAgent(prepared);
    return;
  }
  if (provider === "gemini") {
    yield* streamGeminiAgent(prepared);
    return;
  }
  yield* streamClaudeAgent(prepared);
}

/** Convenience wrapper for request/response routes. */
export async function runAgent(req: AgentRequest): Promise<AgentResult> {
  let result: AgentResult = {
    ok: false,
    text: "No result from agent",
    sessionId: req.sessionId,
  };
  for await (const event of streamAgent(req)) {
    if (event.type === "init") result.sessionId = event.sessionId;
    else if (event.type === "result") {
      result = {
        ok: event.ok,
        text: event.text,
        sessionId: result.sessionId,
        structuredOutput: event.structuredOutput,
      };
    } else if (event.type === "error") {
      result = { ok: false, text: event.message, sessionId: result.sessionId };
    }
  }
  return result;
}

function claudeUsage(modelUsage: Record<string, ModelUsage>): RunUsage {
  let tokens = 0;
  let costUsd = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    tokens +=
      u.inputTokens +
      u.outputTokens +
      u.cacheReadInputTokens +
      u.cacheCreationInputTokens;
    costUsd += u.costUSD;
  }
  return { tokens, costUsd };
}

async function* streamClaudeAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const kill = new AbortController();
  // The prompt goes in as a stream that stays open for the turn: the CLI then
  // treats a message sent mid-turn like one typed into Claude Code while it
  // works, folding it in with the next tool result rather than after the turn
  // (a message that misses the turn's last tool call runs as its own turn on
  // the same process). Closing the stream is what lets the process exit.
  const pending: SDKUserMessage[] = [];
  let wake = () => {};
  let closed = false;
  const push = (text: string): boolean => {
    if (closed) return false;
    pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    wake();
    return true;
  };
  const endInput = () => {
    closed = true;
    wake();
  };
  push(req.prompt);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = pending.shift();
      if (next) yield next;
      else if (closed) return;
      else await new Promise<void>((r) => (wake = r));
    }
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: req.workspaceDir,
      model,
      maxTurns: req.maxTurns ?? 150,
      abortController: kill,
      // Fable models get a 1M-token window on the first-party API and only
      // auto-compact near it, so every turn re-reads a huge context; pin the
      // window to 200k. `env` replaces the child env, so process.env must
      // come along.
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
        // A background shell or agent dies with this process at the end of
        // the turn, and the CLI resuming the session next turn finds the
        // orphan, marks it stopped and, in the same breath, aborts every MCP
        // call in that process: each board tool call then comes back as "The
        // tool call was interrupted before a result was received", whether or
        // not the handler ran. So the project agent, whose session is resumed
        // turn after turn, is not allowed to background anything.
        ...(req.disableBackgroundTasks ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
      },
      ...(resume ? { resume: resume.raw } : {}),
      // The workspace's CLAUDE.md only; the person's own settings and local
      // overrides are theirs, not the project's.
      settingSources: ["project"],
      ...(req.systemPromptAppend
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: req.systemPromptAppend,
            },
          }
        : {}),
      ...(req.writeAccess
        ? {
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }
        : { permissionMode: "dontAsk" as const }),
      ...(req.disallowedTools ? { disallowedTools: req.disallowedTools } : {}),
      ...(req.mcpServers
        ? {
            mcpServers: req.mcpServers,
            allowedTools: Object.keys(req.mcpServers).map((n) => `mcp__${n}__*`),
          }
        : {}),
      ...(req.agents ? { agents: req.agents } : {}),
      ...(req.forwardSubagentText ? { forwardSubagentText: true } : {}),
      ...(req.outputSchema
        ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: req.outputSchema,
            },
          }
        : {}),
    },
  });

  // Claude's interrupt is only effective after init, so hold an early stop
  // until the session is live and keep process abort as the backstop.
  let live = false;
  let sent = false;
  const interrupt = () => {
    if (!live || sent) return;
    sent = true;
    q.interrupt().catch(() => {});
  };
  const onAbort = () => {
    interrupt();
    setTimeout(() => kill.abort(), 8000).unref?.();
  };
  if (req.signal.aborted) onAbort();
  req.signal.addEventListener("abort", onAbort);

  try {
    yield { type: "input", push };
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        live = true;
        if (req.signal.aborted) interrupt();
        yield {
          type: "init",
          sessionId: tagSession("claude", msg.session_id),
        };
      } else if (msg.type === "assistant") {
        const sub = msg.parent_tool_use_id !== null;
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            yield { type: "text", text: block.text, ...(sub && { sub }) };
          } else if (block.type === "tool_use") {
            yield {
              type: "tool",
              text: describeTool(block.name, block.input),
              ...(sub && { sub }),
            };
            // Only the main agent's own subagents; a subagent's nested ones
            // would be finished before their parent's result anyway.
            if (!sub && (block.name === "Agent" || block.name === "Task")) {
              const i = block.input as { description?: string; subagent_type?: string };
              yield {
                type: "subagent",
                id: block.id,
                description: i.description ?? "",
                agentType: i.subagent_type,
              };
            }
          }
        }
      } else if (msg.type === "user" && msg.parent_tool_use_id === null) {
        // A tool result addressed to the main agent ends whichever subagent
        // the same tool_use started (other tools' results match nothing).
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") yield { type: "subagent-end", id: block.tool_use_id };
          }
        }
      } else if (msg.type === "result") {
        // modelUsage is the SDK's own accounting field (main loop, subagents
        // and internal calls), cumulative over this query() call, so the last
        // result message carries the whole session.
        const usage = claudeUsage(msg.modelUsage);
        yield msg.subtype === "success"
          ? {
              type: "result",
              ok: !msg.is_error,
              text: msg.result,
              structuredOutput: msg.structured_output,
              usage,
            }
          : {
              type: "result",
              ok: false,
              text: `Agent stopped: ${msg.subtype}`,
              usage,
            };
        // Stopping drops whatever was pushed and not yet heard; otherwise the
        // process keeps going only while a pushed message still has to run.
        if (req.signal.aborted) break;
        if (!msg.queued_turn_count) endInput();
      }
    }
  } catch (err) {
    yield { type: "error", message: String(err) };
  } finally {
    endInput();
    req.signal.removeEventListener("abort", onAbort);
  }
}
