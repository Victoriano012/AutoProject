import { tagSession } from "../agent-session";
import { resumableSession, resolveReasoningEffort } from "./model-settings";
import type { AgentEvent, AgentRequest } from "./agent-types";
import { createCliSession, parseStructured } from "./cli-process";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  query?: string;
  tool?: string;
  server?: string;
  changes?: { path?: string }[];
}

/** One line from `codex app-server`: an answer to one of our requests, a
 * notification, or (method and id) a request of its own. */
interface CodexMessage {
  id?: number;
  method?: string;
  result?: { thread?: { id: string }; turn?: { id: string } };
  error?: { message?: string };
  params?: {
    item?: CodexItem;
    turn?: { id: string; status?: string; error?: { message?: string } | null };
    tokenUsage?: { last?: { inputTokens?: number; outputTokens?: number } };
    error?: { message?: string };
    willRetry?: boolean;
  };
}

/** How the thread is opened. Kept separate and exported so the CLI contract
 * can be tested without starting a model run. */
export function codexThread(
  req: Pick<AgentRequest, "model" | "sessionId" | "workspaceDir" | "writeAccess" | "reasoningEffort">
): { method: "thread/start" | "thread/resume"; params: Record<string, unknown> } {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const effort = resolveReasoningEffort(model, req.reasoningEffort);
  return {
    method: resume ? "thread/resume" : "thread/start",
    params: {
      ...(resume && { threadId: resume.raw }),
      model,
      cwd: req.workspaceDir,
      approvalPolicy: "never",
      sandbox: req.writeAccess ? "danger-full-access" : "read-only",
      ...(effort && { config: { model_reasoning_effort: effort } }),
    },
  };
}

function toolText(item: CodexItem): string | undefined {
  if (item.type === "commandExecution") {
    return item.command ? `Bash: ${item.command.slice(0, 200)}` : "Bash";
  }
  if (item.type === "fileChange") {
    const files = item.changes?.flatMap((change) =>
      change.path ? [change.path] : []
    );
    return files?.length ? `Edit: ${files.join(", ").slice(0, 200)}` : "Edit files";
  }
  if (item.type === "mcpToolCall") {
    const name = [item.server, item.tool].filter(Boolean).join(": ");
    return name ? `MCP: ${name}` : "MCP tool";
  }
  if (item.type === "webSearch") {
    return item.query ? `Web search: ${item.query.slice(0, 200)}` : "Web search";
  }
  if (item.type === "plan") return "Update plan";
}

/** Runs and discovery hold the Codex CLI while they use it. An update starts
 * only when nothing holds it, and whoever arrives meanwhile waits for it (ten
 * minutes at most, should an install hang), so no run starts on a half-installed
 * Codex. On globalThis: runs and refreshes are served by different route bundles. */
const codexUse = ((globalThis as { autoProjectCodex?: { holders: number; update?: Promise<void> } })
  .autoProjectCodex ??= { holders: 0 });

export const codexUpdating = () => Boolean(codexUse.update);

/** Rejects once `signal` aborts: a run stopped while it waits ends at once,
 * and the install it waited on carries on. */
export async function holdCodex(signal?: AbortSignal): Promise<() => void> {
  while (codexUse.update) {
    signal?.throwIfAborted();
    await Promise.race([codexUse.update, new Promise((r) => signal?.addEventListener("abort", r, { once: true }))]);
  }
  signal?.throwIfAborted();
  codexUse.holders++;
  return () => { codexUse.holders--; };
}

/** Start `update` unless Codex is in use or already updating. What it returns
 * settles only once the lock is free again. */
export function updateWhenIdle<T>(update: () => Promise<T>): Promise<T> | undefined {
  if (codexUse.holders || codexUse.update) return;
  const running = update();
  const done = () => { codexUse.update = undefined; };
  const lock = Promise.race([running, new Promise((r) => setTimeout(r, 600_000).unref())]).then(done, done);
  codexUse.update = lock;
  return lock.then(() => running);
}


/** Codex's app-server protocol supplies session, progress, tool, and final
 * message events while auth stays entirely inside the local Codex CLI. It also
 * takes a message mid-turn, which the model reads at its next step, as Claude
 * does. */
export async function* streamCodexAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const release = await holdCodex(req.signal).catch(() => undefined);
  try {
    if (!release) { yield { type: "error", message: "Agent stopped" }; return; }
    yield* runCodex(req);
  } finally { release?.(); }
}

async function* runCodex(req: AgentRequest): AsyncGenerator<AgentEvent> {
  // A stop goes through Codex (turn/interrupt), which ends the commands its
  // turns run: a killed app-server would leave them running in the workspace.
  // The process itself is killed only if it does not wind down.
  const kill = new AbortController();
  const cli = await createCliSession({ ...req, signal: kill.signal }, {
    label: "Codex",
    executable: process.env.AUTOPROJECT_CODEX_PATH?.trim() || "codex",
    args: () => ["app-server"],
    interactive: true,
  });
  let id = 0;
  const call = (method: string, params: unknown) => {
    cli.send({ id: ++id, method, params });
    return id;
  };
  call("initialize", { clientInfo: { name: "autoproject", title: "AutoProject", version: "0.1.0" }, capabilities: null });
  cli.send({ method: "initialized" });
  const thread = codexThread(req);
  const opening = call(thread.method, thread.params);
  let threadId = "";
  // turn/start on a turn at work adds the message to it (a steer), the model
  // reading it at its next step; on an idle thread it starts the next turn.
  // The process ends once every message sent has been answered.
  const asked = new Set<number>();
  const open = new Set<string>();
  const over = new Set<string>();
  let closed = false;
  const send = (text: string) => asked.add(call("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    ...(req.outputSchema && { outputSchema: req.outputSchema }),
  }));
  // Worded as Claude Code words a message sent mid-turn, or the model may
  // finish what it was doing and never answer it.
  const push = (text: string): boolean => {
    if (closed) return false;
    send(`The person sent this while you were working:\n\n${text}\n\nAnswer it now, then carry on with your work.`);
    return true;
  };
  let finalText = "";
  let failure: string | undefined;
  let tokens = 0;
  let resultSent = false;
  const seenTools = new Set<string>();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    closed = true;
    for (const turnId of open) call("turn/interrupt", { threadId, turnId });
    killTimer = setTimeout(() => kill.abort(), 3000);
  };
  req.signal.addEventListener("abort", stop, { once: true });
  if (req.signal.aborted) stop();

  try {
    for await (const raw of cli.events) {
      const msg = raw as CodexMessage;
      const params = msg.params ?? {};
      if (msg.method && msg.id !== undefined) {
        // Approvals never come (approvalPolicy "never"); nothing else can be answered headless.
        cli.send({ id: msg.id, error: { code: -32601, message: "Not supported" } });
      } else if (msg.id === opening) {
        if (!msg.result?.thread) {
          // A thread Codex no longer has: "no rollout found for thread id …".
          resultSent = true;
          yield { type: "error", message: msg.error?.message ?? "Codex could not open the thread" };
          break;
        }
        threadId = msg.result.thread.id;
        yield { type: "init", sessionId: tagSession("codex", threadId) };
        send(req.prompt);
        yield { type: "input", push };
      } else if (msg.id !== undefined && asked.has(msg.id)) {
        asked.delete(msg.id);
        const turn = msg.result?.turn?.id;
        if (!turn) {
          resultSent = true;
          yield { type: "result", ok: false, text: msg.error?.message ?? "Codex run failed" };
          break;
        }
        if (!over.has(turn)) open.add(turn);
        else if (!asked.size && !open.size) { closed = true; break; }
      } else if ((msg.method === "item/started" || msg.method === "item/completed") && params.item) {
        const item = params.item;
        if (item.type === "agentMessage") {
          if (msg.method === "item/completed" && item.text?.trim()) {
            finalText = item.text;
            yield { type: "text", text: item.text };
          }
          continue;
        }
        const text = toolText(item);
        const key = item.id ?? `${item.type}:${text}`;
        if (text && !seenTools.has(key)) {
          seenTools.add(key);
          yield { type: "tool", text };
        }
      } else if (msg.method === "thread/tokenUsage/updated") {
        // Each model request's own usage; input already includes the cached
        // tokens. No cost figure exists, so `usage.costUsd` stays absent.
        const last = params.tokenUsage?.last;
        tokens += (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0);
      } else if (msg.method === "error" && !params.willRetry) {
        failure = params.error?.message;
      } else if (msg.method === "turn/completed" && params.turn) {
        open.delete(params.turn.id);
        over.add(params.turn.id);
        resultSent = true;
        const usage = { tokens };
        tokens = 0;
        if (params.turn.status !== "completed") {
          yield { type: "result", ok: false, text: params.turn.error?.message ?? failure ?? "Codex run failed", usage };
        } else if (req.outputSchema) {
          const parsed = parseStructured(finalText, "Codex");
          yield parsed.ok
            ? { type: "result", ok: true, text: finalText, structuredOutput: parsed.value, usage }
            : { type: "result", ok: false, text: parsed.message, usage };
        } else {
          yield { type: "result", ok: true, text: finalText, usage };
        }
        failure = undefined;
        if (!asked.size && !open.size) { closed = true; break; }
      }
    }
    closed = true;
    if (!resultSent) {
      const status = await cli.exit;
      yield { type: "error", message: cli.failure(status, "Codex CLI was not found. Install it, run `codex login`, and restart AutoProject.") };
    }
  } finally {
    closed = true;
    req.signal.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    await cli.close();
  }
}
