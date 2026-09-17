import { query, type ModelUsage, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resumableSession, tagSession } from "../agent-session";
import { resolveReasoningEffort } from "../models";
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

/** Keep unsupported effort values out of the Claude SDK request. */
export function claudeReasoningOptions(
  req: Pick<AgentRequest, "model" | "reasoningEffort">
): Pick<Options, "effort"> {
  const effort = resolveReasoningEffort(req.model!, req.reasoningEffort);
  return effort && effort !== "ultra" ? { effort } : {};
}

export async function* streamClaudeAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
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
    if (killTimer) clearTimeout(killTimer);
    q.close();
  }
}
