import type { AgentDefinition, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AttachmentPayload } from "../attachments";
import type { ReasoningEffort } from "../models";

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
  reasoningEffort?: ReasoningEffort;
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


export interface AgentProvider {
  stream: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
}
