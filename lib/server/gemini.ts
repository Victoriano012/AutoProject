import { resumableSession, tagSession } from "../agent-session";
import { resolveReasoningEffort } from "../models";
import type { AgentEvent, AgentRequest } from "./agent-types";
import { createCliSession, parseStructured } from "./cli-process";

interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
}

interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyEvent {
  event?: string;
  conversation_id?: string;
  step_update?: AgyStepUpdate;
  result?: AgyResult;
}

/** Kept separate and exported so the CLI contract can be tested without
 * starting a model run. */
export function geminiArgs(
  req: Pick<
    AgentRequest,
    "model" | "sessionId" | "workspaceDir" | "writeAccess" | "reasoningEffort"
  >,
  schemaPath?: string
): string[] {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const args = ["--output-format", "stream-json"];
  if (resume) args.push("--conversation", resume.raw);
  // Pin the actual variant: a saved '-high' slug must not override the slider.
  const effort = resolveReasoningEffort(model, req.reasoningEffort);
  const selectedModel = effort ? `${model.replace(/-(low|medium|high)$/, "")}-${effort}` : model;
  args.push("--model", selectedModel);
  if (schemaPath) args.push("--json-schema", schemaPath);
  if (req.writeAccess) args.push("--dangerously-skip-permissions");
  return args;
}

function toolText(toolName?: string, toolInfo?: AgyToolInfo): string | undefined {
  const name = toolName ?? toolInfo?.name ?? "";
  const params = toolInfo?.parameters ?? {};
  if (name === "run_command") {
    return params.CommandLine ? `Bash: ${String(params.CommandLine).slice(0, 200)}` : "Bash";
  }
  if (name === "write_to_file") {
    return params.TargetFile ? `Write: ${String(params.TargetFile).slice(0, 200)}` : "Write file";
  }
  if (name === "replace_file_content" || name === "multi_replace_file_content") {
    return params.TargetFile ? `Edit: ${String(params.TargetFile).slice(0, 200)}` : "Edit file";
  }
  if (name === "view_file") {
    return params.AbsolutePath ? `Read: ${String(params.AbsolutePath).slice(0, 200)}` : "Read file";
  }
  if (name === "list_dir") {
    return params.DirectoryPath ? `List: ${String(params.DirectoryPath).slice(0, 200)}` : "List directory";
  }
  if (name === "grep_search") {
    return params.Query ? `Grep: ${String(params.Query).slice(0, 200)}` : "Grep";
  }
  if (name === "find_by_name") {
    return params.Pattern ? `Find: ${String(params.Pattern).slice(0, 200)}` : "Find";
  }
  if (name === "read_url_content") {
    return params.Url ? `URL: ${String(params.Url).slice(0, 200)}` : "Fetch URL";
  }
  if (name === "search_web") {
    return params.query ? `Web search: ${String(params.query).slice(0, 200)}` : "Web search";
  }
  if (name) {
    const firstVal = Object.values(params)[0];
    return typeof firstVal === "string" && firstVal.trim()
      ? `${name}: ${firstVal.slice(0, 200)}`
      : name;
  }
}

/** Antigravity CLI's stream-json mode supplies session, progress, tool, and final
 * message events while auth stays inside the local CLI environment. */
export async function* streamGeminiAgent(
  req: AgentRequest
): AsyncGenerator<AgentEvent> {
  if (req.signal.aborted) { yield { type: "error", message: "Agent stopped" }; return; }
  const cli = await createCliSession(req, {
    label: "Gemini (agy)",
    executable: process.env.AUTOPROJECT_AGY_PATH?.trim() || process.env.AUTOPROJECT_GEMINI_PATH?.trim() || "agy",
    args: (schemaPath) => [...geminiArgs(req, schemaPath), "--print", req.prompt],
  });
  let finalText = "";
  let resultSent = false;
  const seenTools = new Set<string>();

  try {
    for await (const raw of cli.events) {
      const event = raw as AgyEvent;

      if (event.event === "init" && event.conversation_id) {
        yield {
          type: "init",
          sessionId: tagSession("gemini", event.conversation_id),
        };
      } else if (event.event === "step_update" && event.step_update) {
        const step = event.step_update;
        if (step.step_type === "agent_response" && step.text_delta) {
          finalText += step.text_delta;
          yield { type: "text", text: step.text_delta };
        } else if (step.step_type === "tool") {
          const text = toolText(step.tool_name, step.tool_info);
          const key = `${step.step_index}:${text}`;
          if (text && !seenTools.has(key)) {
            seenTools.add(key);
            yield { type: "tool", text };
          }
        }
      } else if (event.event === "result" && event.result) {
        resultSent = true;
        const res = event.result;
        if (res.status === "SUCCESS") {
          const usage = res.usage
            ? {
                tokens:
                  (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0),
              }
            : undefined;
          const responseText = res.response ?? finalText;
          if (req.outputSchema) {
            if (res.structured_output !== undefined) {
              yield {
                type: "result",
                ok: true,
                text: responseText,
                structuredOutput: res.structured_output,
                usage,
              };
            } else {
              const parsed = parseStructured(responseText, "Gemini");
              yield parsed.ok
                ? {
                    type: "result",
                    ok: true,
                    text: responseText,
                    structuredOutput: parsed.value,
                    usage,
                  }
                : { type: "result", ok: false, text: parsed.message, usage };
            }
          } else {
            yield {
              type: "result",
              ok: true,
              text: responseText,
              usage,
            };
          }
        } else {
          yield {
            type: "result",
            ok: false,
            text: res.error || res.response || "Gemini run failed",
          };
        }
      }
    }

    const status = await cli.exit;
    if (!resultSent) {
      yield { type: "error", message: cli.failure(status, "Antigravity CLI (agy) was not found. Install it, authenticate with your Gemini account, and restart AutoProject.") };
    }
  } finally {
    await cli.close();
  }
}
