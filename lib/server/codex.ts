import { resumableSession, tagSession } from "../agent-session";
import { resolveReasoningEffort } from "../models";
import type { AgentEvent, AgentRequest } from "./agent-types";
import { createCliSession, parseStructured } from "./cli-process";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  query?: string;
  name?: string;
  server?: string;
  changes?: { path?: string }[];
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  item?: CodexItem;
  /** turn.completed only. Codex reports tokens but never a cost. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Kept separate and exported so the CLI contract can be tested without
 * starting a model run. */
export function codexArgs(
  req: Pick<
    AgentRequest,
    "model" | "sessionId" | "workspaceDir" | "writeAccess" | "reasoningEffort"
  >,
  schemaPath?: string
): string[] {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const args = ["exec"];
  if (resume) args.push("resume", resume.raw);
  args.push("--json", "--model", model, "--skip-git-repo-check");
  const effort = resolveReasoningEffort(model, req.reasoningEffort);
  if (effort) args.push("--config", `model_reasoning_effort="${effort}"`);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (req.writeAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (!resume) args.push("--sandbox", "read-only");
  if (!resume) args.push("--cd", req.workspaceDir!);
  args.push("-");
  return args;
}

function errorText(event: CodexEvent): string {
  if (typeof event.error === "string") return event.error;
  return event.error?.message ?? event.message ?? "Codex run failed";
}

function toolText(item: CodexItem): string | undefined {
  if (item.type === "command_execution") {
    return item.command ? `Bash: ${item.command.slice(0, 200)}` : "Bash";
  }
  if (item.type === "file_change") {
    const files = item.changes?.flatMap((change) =>
      change.path ? [change.path] : []
    );
    return files?.length ? `Edit: ${files.join(", ").slice(0, 200)}` : "Edit files";
  }
  if (item.type === "mcp_tool_call") {
    const name = [item.server, item.name].filter(Boolean).join(": ");
    return name ? `MCP: ${name}` : "MCP tool";
  }
  if (item.type === "web_search") {
    return item.query ? `Web search: ${item.query.slice(0, 200)}` : "Web search";
  }
  if (item.type === "plan") return "Update plan";
}

/** Codex's documented JSONL mode supplies session, progress, tool, and final
 * message events while auth stays entirely inside the local Codex CLI. */
export async function* streamCodexAgent(
  req: AgentRequest
): AsyncGenerator<AgentEvent> {
  if (req.signal.aborted) { yield { type: "error", message: "Agent stopped" }; return; }
  const cli = await createCliSession(req, {
    label: "Codex",
    executable: process.env.AUTOPROJECT_CODEX_PATH?.trim() || "codex",
    args: (schemaPath) => codexArgs(req, schemaPath),
    stdin: req.prompt,
  });
  let finalText = "";
  let resultSent = false;
  const seenTools = new Set<string>();

  try {
    for await (const raw of cli.events) {
      const event = raw as CodexEvent;

      if (event.type === "thread.started" && event.thread_id) {
        yield {
          type: "init",
          sessionId: tagSession("codex", event.thread_id),
        };
      } else if (event.type === "item.completed" && event.item) {
        if (event.item.type === "agent_message" && event.item.text?.trim()) {
          finalText = event.item.text;
          yield { type: "text", text: event.item.text };
        } else {
          const text = toolText(event.item);
          const key = event.item.id ?? `${event.item.type}:${text}`;
          if (text && !seenTools.has(key)) {
            seenTools.add(key);
            yield { type: "tool", text };
          }
        }
      } else if (event.type === "item.started" && event.item) {
        const text = toolText(event.item);
        const key = event.item.id ?? `${event.item.type}:${text}`;
        if (text && !seenTools.has(key)) {
          seenTools.add(key);
          yield { type: "tool", text };
        }
      } else if (event.type === "turn.completed") {
        resultSent = true;
        // input_tokens already includes the cached ones; no cost figure exists
        // here, so `usage.costUsd` stays absent rather than being invented.
        const usage = {
          tokens: (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0),
        };
        if (req.outputSchema) {
          const parsed = parseStructured(finalText, "Codex");
          yield parsed.ok
            ? {
                type: "result",
                ok: true,
                text: finalText,
                structuredOutput: parsed.value,
                usage,
              }
            : { type: "result", ok: false, text: parsed.message, usage };
        } else {
          yield { type: "result", ok: true, text: finalText, usage };
        }
      } else if (event.type === "turn.failed" || event.type === "error") {
        resultSent = true;
        yield { type: "result", ok: false, text: errorText(event) };
      }
    }

    const status = await cli.exit;
    if (!resultSent) {
      yield { type: "error", message: cli.failure(status, "Codex CLI was not found. Install it, run `codex login`, and restart AutoProject.") };
    }
  } finally {
    await cli.close();
  }
}
