import fs from "fs";
import os from "os";
import path from "path";
import { type AttachmentPayload, writeAttachments } from "../attachments";
import { selectedAgentSettings } from "../config";
import { providerForModel, resolveReasoningEffort } from "../models";
import { streamCodexAgent } from "./codex";
import { streamGeminiAgent } from "./gemini";
import { streamClaudeAgent } from "./claude";
import type { AgentEvent, AgentProvider, AgentRequest, AgentResult } from "./agent-types";
export type { AgentEvent, AgentProvider, AgentRequest, AgentResult, RunUsage } from "./agent-types";
export { claudeReasoningOptions } from "./claude";

const providers: Record<ReturnType<typeof providerForModel>, AgentProvider> = {
  claude: { stream: streamClaudeAgent },
  codex: { stream: streamCodexAgent },
  gemini: { stream: streamGeminiAgent },
};

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
    path.join(cwd, ".autoproject", "agent-inputs"),
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
  const settings = selectedAgentSettings(req.model);
  const { model } = settings;
  const reasoningEffort = resolveReasoningEffort(model, req.reasoningEffort ?? settings.reasoningEffort);
  const prompt = promptWithAttachments(cwd, req.prompt, req.attachments);
  const prepared = { ...req, workspaceDir: cwd, prompt, model, reasoningEffort };

  yield* providers[providerForModel(model)].stream(prepared);
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
