import fs from "node:fs";
import path from "node:path";
import { query, type ModelUsage, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { tagSession } from "../agent-session";
import { resumableSession, resolveReasoningEffort } from "./model-settings";
import type { AgentEvent, AgentRequest, RunUsage } from "./agent-types";

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

/** The person's own `claude` updates itself; the copy bundled with the SDK is
 * only as new as node_modules. The CLI decides which models exist and what
 * `opus` means, so discovery and turns both use theirs, else the bundled one. */
export function claudeExecutable(): string | undefined {
  const configured = process.env.AUTOPROJECT_CLAUDE_PATH?.trim();
  if (configured) return configured;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, "claude");
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* not here */ }
  }
}

/** Workers and the project agent resume a conversation for as long as the
 * ticket lives, and the CLI deletes transcripts older than 30 days by default.
 * Passed as `--settings`, so it holds without reading the person's settings. */
export const CLAUDE_SETTINGS = { cleanupPeriodDays: 365 };

/** Keep unsupported effort values out of the Claude SDK request. */
export function claudeReasoningOptions(
  req: Pick<AgentRequest, "model" | "reasoningEffort">
): Pick<Options, "effort"> {
  const effort = resolveReasoningEffort(req.model!, req.reasoningEffort);
  return effort && effort !== "ultra" && effort !== "none" && effort !== "minimal" ? { effort } : {};
}

export async function* streamClaudeAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const kill = new AbortController();
  // The prompt goes in as a stream that stays open for the turn: the CLI then
  // treats a message sent mid-turn like one typed into Claude Code while it
  // works, folding it in with the next tool result rather than after the turn
  // (a message that misses the turn's last tool call runs as its own turn on
  // the same process). Closing the stream is what lets the process exit, so
  // it stays open until the turn is over and no background work (a subagent,
  // a shell) is left: the agent answers messages while its subagents run, and
  // the process never exits with a task still going. Such an orphan is found
  // when the next turn resumes the session, and the CLI aborts every MCP call
  // in flight as it marks it stopped: board tool calls then fail with "The
  // tool call was interrupted before a result was received".
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
      pathToClaudeCodeExecutable: claudeExecutable(),
      model,
      ...claudeReasoningOptions(req),
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
      },
      ...(resume ? { resume: resume.raw } : {}),
      // The workspace's CLAUDE.md only; the person's own settings and local
      // overrides are theirs, not the project's.
      settingSources: ["project"],
      settings: CLAUDE_SETTINGS,
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
  // What the next turn on this conversation starts by re-reading.
  let contextTokens: number | undefined;
  // Whether the main agent's turn is over, how many sent messages the CLI
  // still holds for it, and how many background tasks are still running.
  let idle = false;
  let queued = 0;
  let background = 0;
  const settle = () => {
    if (idle && !queued && !background) endInput();
  };
  const interrupt = () => {
    if (!live || sent) return;
    sent = true;
    q.interrupt().catch(() => {});
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    interrupt();
    if (!killTimer) {
      killTimer = setTimeout(() => kill.abort(), 8000);
      killTimer.unref?.();
    }
  };
  if (req.signal.aborted) onAbort();
  req.signal.addEventListener("abort", onAbort);

  try {
    yield { type: "input", push };
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        // Every turn starts with one: a pushed message's, or the one in which
        // the agent hears that a background task finished.
        live = true;
        idle = false;
        if (req.signal.aborted) interrupt();
        yield {
          type: "init",
          sessionId: tagSession("claude", msg.session_id),
        };
      } else if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
        // The whole set each time; ambient ones are watchers, not work. A stop
        // while the agent waits on its tasks ends them, and so the process.
        background = msg.tasks.filter((t) => !t.ambient).length;
        settle();
      } else if (msg.type === "system" && msg.subtype === "task_notification") {
        // A subagent, foreground or background, is over when its task is;
        // ids of other tasks (shells) match no subagent.
        if (msg.tool_use_id) yield { type: "subagent-end", id: msg.tool_use_id };
      } else if (msg.type === "assistant") {
        const sub = msg.parent_tool_use_id !== null;
        const u = msg.message.usage;
        if (!sub && u) {
          contextTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
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
      } else if (msg.type === "result") {
        // modelUsage is the SDK's own accounting field (main loop, subagents
        // and internal calls), cumulative over this query() call, so the last
        // result message carries the whole session.
        const usage = { ...claudeUsage(msg.modelUsage), contextTokens };
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
        // Stopping drops whatever was pushed and not yet heard; the stop has
        // already ended the background tasks, before this result.
        if (req.signal.aborted) break;
        idle = true;
        queued = msg.queued_turn_count ?? 0;
        settle();
      }
    }
  } catch (err) {
    yield { type: "error", message: String(err) };
  } finally {
    endInput();
    req.signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    q.close();
  }
}
