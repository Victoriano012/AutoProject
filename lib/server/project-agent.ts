import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { selectedModel } from "../config";
import { providerForModel } from "../models";
import {
  type AgentRequest,
  type ChatEntry,
  isTicketDone,
  type Mode,
  type Project,
} from "../types";
import { streamAgent } from "./agent";
import { addTicketsToBoard, boardServer, REQUEST_SCHEMA } from "./board-tools";
import * as store from "./project-store";
import type { PlannedTicket } from "./project-store";
import { ensureLoaded, notifyAgent, registry } from "./runs";

/**
 * The one agent behind a project: a single Claude session resumed on every
 * turn, told per turn whether it is planning tickets (panel) or doing the work
 * itself (act). Both modes write to one transcript, `Project.chat`, streamed to
 * the browser through the project feed; the browser only ever asks for a turn.
 *
 * Turns are taken one at a time from a per-project queue (`registry.requests`),
 * in the order the messages were sent: one conversation, so a second message
 * waits for the first to finish rather than being refused. The queue lives in
 * memory beside the live turn; a server restart forgets both.
 */

export const ACT_AGENTS: Record<string, AgentDefinition> = {
  worker: {
    description:
      "Implements one self-contained coding subtask in the workspace and reports what changed.",
    prompt:
      "You are a focused engineer working inside the current repository. Do exactly the subtask you are given, then reply with a 2-4 sentence summary of the changes.",
    permissionMode: "bypassPermissions",
    maxTurns: 80,
    model: "inherit",
  },
  scout: {
    description: "Read-only exploration: find files, trace code paths, summarize.",
    prompt: "Explore the repository and answer precisely; never modify files.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "dontAsk",
    maxTurns: 40,
  },
};

/** The agent's standing role, appended to the system prompt every turn. */
export function systemAppend(project: Project): string {
  const description = project.description.trim();
  return [
    `You are the single agent behind the project '${project.name}'.` +
      (description ? ` ${description}${/[.!?]$/.test(description) ? "" : "."}` : ""),
    `You have two ways of working, told to you at the top of each message: PANEL — you plan; you never modify files; you turn the human's message into tickets with mcp__board__add_tickets and record standing preferences with mcp__board__set_notes. ACT — you do the work yourself in the workspace and use the Agent tool (subagent_type 'worker' for independent coding subtasks that can run in parallel, 'scout' for read-only exploration) and keep the coordinating work yourself. The conversation is continuous across both.`,
    project.notes.length
      ? `\nStanding instructions for this project (always apply):\n${project.notes
          .map((n) => `- ${n}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function boardState(project: Project): string {
  const open = project.tickets.filter((t) => !isTicketDone(t));
  return open.length
    ? `Unsolved tickets on the board:\n${open.map((t) => `- ${t.title} [${t.status}]`).join("\n")}`
    : `The board has no unsolved tickets.`;
}

/** The workers as the planner sees them, so it can name one by number. */
function workerList(project: Project): string {
  return project.workers.length
    ? `Workers (each a long-lived coding agent with its own conversation):\n${project.workers
        .map((w) => `- #${w.n} — ${w.description}`)
        .join("\n")}`
    : `There are no workers yet.`;
}

export function panelPreamble(project: Project, message: string): string {
  return [
    `MODE: PANEL`,
    boardState(project),
    workerList(project),
    `Rules:
- Prefer fewer, larger tickets: one ticket per coherent change an agent can finish in one session. Work that is tightly coupled (same feature, same files, one depends on the other) is ONE ticket, never several.
- \`files\` lists every workspace-relative path the ticket will create or modify; the board runs tickets sharing a file one after another.
- \`worker\` says who runs the ticket: {"existing": n} or {"new": "<description>"}. A worker runs its tickets one after another, in one conversation, so tickets on the same worker never run in parallel: spread the work. Reuse a worker only when the ticket continues that worker's own earlier work (same feature, same files) and its context saves real effort; tickets in different areas go to different workers, and when in doubt make a new one. A description is under 12 words and names an area of the codebase or a kind of work, not the single ticket. New workers are numbered on from the last existing one, so a later ticket in the same call can name a worker an earlier one created ({"new": ...} on the first, {"existing": n} on the rest).
- If the message is a question, a preference or needs no code, call add_tickets with [] (or not at all) and answer in one or two sentences. If it states a lasting preference ('always use pnpm', 'never touch /legacy'), call set_notes with the full updated list.
- Do not modify files in this mode.`,
    `Human:\n${message}`,
  ].join("\n\n");
}

export function actPreamble(project: Project, message: string): string {
  const running = project.tickets.filter((t) => t.status === "running");
  return [
    `MODE: ACT`,
    boardState(project),
    running.length
      ? `Ticket agents are working right now; leave their files alone:\n${running
          .map((t) => `- ${t.title}: ${t.files?.length ? t.files.join(", ") : "(no files listed)"}`)
          .join("\n")}`
      : "",
    `Human:\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function say(dir: string, mode: Mode, entry: Omit<ChatEntry, "ts" | "mode">) {
  store.appendChat(dir, [{ ...entry, ts: Date.now(), mode }]);
}

function requests(dir: string): AgentRequest[] {
  let list = registry.requests.get(dir);
  if (!list) registry.requests.set(dir, (list = []));
  return list;
}

/** Queue one message for the project agent, in `mode`. It runs as soon as the
 * turns before it are done; the reply travels through the project feed. In the
 * chat (act) the person is talking to the agent at work, so while an act turn
 * runs the message goes straight into it instead — the agent hears it with its
 * next tool result — and it is written to the transcript now, as heard. */
export function sendToAgent(dir: string, mode: Mode, message: string): AgentRequest | null {
  if (!ensureLoaded(dir)) throw new Error(`No project at ${dir}`);
  if (
    mode === "act" &&
    registry.agentMode.get(dir) === "act" &&
    registry.inputs.get(dir)?.(message)
  ) {
    say(dir, mode, { kind: "user", text: message });
    return null;
  }
  const req: AgentRequest = { id: crypto.randomUUID(), mode, text: message, state: "queued" };
  requests(dir).push(req);
  notifyAgent(dir);
  void pump(dir);
  return req;
}

/** Take the next waiting request, if no turn is running. Every finished turn
 * calls this again, which is what drains the queue. */
async function pump(dir: string): Promise<void> {
  if (registry.agents.has(dir)) return;
  const req = requests(dir).find((r) => r.state === "queued");
  if (!req) return;
  const ctrl = new AbortController();
  registry.agents.set(dir, ctrl);
  registry.agentMode.set(dir, req.mode);
  req.state = "running";
  // The transcript shows the message when the agent actually hears it, so it
  // reads in the order the agent did — and a request cancelled while waiting
  // was never said at all.
  say(dir, req.mode, { kind: "user", text: req.text });
  notifyAgent(dir);
  let error: string | null = null;
  try {
    error = await turn(dir, req.mode, req.text, ctrl.signal);
  } catch (err) {
    error = String(err);
  } finally {
    registry.agents.delete(dir);
    registry.agentMode.delete(dir);
    registry.subagents.delete(dir);
    // A stopped turn is over and done with; a failed one stays in the stack
    // with its error until the person retries or dismisses it.
    if (error !== null && !ctrl.signal.aborted) {
      req.state = "error";
      req.error = error;
    } else {
      dropRequest(dir, req.id);
    }
    notifyAgent(dir);
    void pump(dir);
  }
}

function dropRequest(dir: string, id: string): void {
  const list = requests(dir);
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) list.splice(i, 1);
}

/** Abort the running turn; the queue moves on to the next request. */
export function stopAgent(dir: string): void {
  registry.agents.get(dir)?.abort();
}

/** The ✕ on a request: a waiting or failed one is dropped; the running one is
 * stopped (and dropped by the turn's own wind-down). */
export function cancelRequest(dir: string, id: string): void {
  const req = requests(dir).find((r) => r.id === id);
  if (!req) return;
  if (req.state === "running") return stopAgent(dir);
  dropRequest(dir, id);
  notifyAgent(dir);
}

/** Send a failed request again, unchanged, at its place in the stack. */
export function retryRequest(dir: string, id: string): void {
  const req = requests(dir).find((r) => r.id === id && r.state === "error");
  if (!req) return;
  req.state = "queued";
  delete req.error;
  notifyAgent(dir);
  void pump(dir);
}

/** One turn. Resolves with the failure the person was shown, or null. */
async function turn(
  dir: string,
  mode: Mode,
  message: string,
  signal: AbortSignal
): Promise<string | null> {
  const model = selectedModel();
  const provider = providerForModel(model);
  // Codex and Gemini have no in-process MCP: their panel turn answers with
  // the ticket list as structured output instead of calling the board tool.
  const fallback = mode === "panel" && provider !== "claude";

  const attempt = async (fresh: boolean): Promise<string | null | "retry"> => {
    const project = store.getProject(dir)!;
    const prompt =
      (mode === "panel" ? panelPreamble : actPreamble)(project, message) +
      (fallback
        ? `\n\nYou have no board tools here: answer with the JSON object of tickets instead.`
        : "");
    const sessionId = fresh ? undefined : project.agentSessionId;
    // Nothing said yet when a resumed turn fails means the resume itself did.
    let produced = false;
    let failed: string | null = null;
    try {
      const events = streamAgent({
        workspaceDir: project.workspaceDir,
        prompt,
        sessionId,
        signal,
        model,
        writeAccess: mode === "act",
        maxTurns: mode === "act" ? 150 : 12,
        systemPromptAppend: systemAppend(project),
        mcpServers: mode === "panel" ? { board: boardServer(dir) } : undefined,
        disallowedTools:
          mode === "panel" ? ["Edit", "Write", "MultiEdit", "NotebookEdit", "Task"] : undefined,
        forwardSubagentText: mode === "act",
        agents: mode === "act" ? ACT_AGENTS : undefined,
        // An act turn that backgrounds a command leaves an orphan that breaks
        // the board tools on the next panel turn (see agent.ts).
        disableBackgroundTasks: true,
        outputSchema: fallback ? REQUEST_SCHEMA : undefined,
      });
      for await (const ev of events) {
        if (ev.type === "input") {
          registry.inputs.set(dir, ev.push);
        } else if (ev.type === "init") {
          store.setAgentSession(dir, ev.sessionId);
        } else if (ev.type === "text" || ev.type === "tool") {
          produced = true;
          say(dir, mode, { kind: ev.type, text: ev.sub ? `  ↳ ${ev.text}` : ev.text });
        } else if (ev.type === "subagent") {
          const live = registry.subagents.get(dir) ?? [];
          registry.subagents.set(dir, [
            ...live,
            { id: ev.id, description: ev.description, type: ev.agentType },
          ]);
          notifyAgent(dir);
        } else if (ev.type === "subagent-end") {
          const live = registry.subagents.get(dir) ?? [];
          if (live.some((s) => s.id === ev.id)) {
            registry.subagents.set(dir, live.filter((s) => s.id !== ev.id));
            notifyAgent(dir);
          }
        } else if (ev.type === "result") {
          if (!ev.ok) failed = ev.text;
          else if (fallback && ev.structuredOutput) {
            const { tickets } = ev.structuredOutput as { tickets: PlannedTicket[] };
            addTicketsToBoard(dir, tickets);
          }
        } else if (ev.type === "error") {
          failed = ev.message;
        }
      }
    } catch (err) {
      failed = String(err);
    }
    registry.inputs.delete(dir);
    if (signal.aborted) {
      say(dir, mode, { kind: "info", text: "Stopped by user" });
      return null;
    }
    if (failed === null) return null;
    // The stored session can be gone (a wiped ~/.claude, another machine's
    // id): forget it and start the conversation over, once.
    if (sessionId && !produced) return "retry";
    say(dir, mode, { kind: "error", text: failed });
    return failed;
  };

  const first = await attempt(false);
  if (first !== "retry") return first;
  store.setAgentSession(dir, undefined);
  const second = await attempt(true);
  return second === "retry" ? null : second; // a fresh attempt has no session to retry
}
