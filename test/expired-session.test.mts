import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock, type TestContext } from "node:test";
import type { AgentEvent, AgentRequest } from "../lib/server/agent-types.ts";

// config.ts reads the home directory on import: mock it first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-expired-"));
mock.method(os, "homedir", () => home);
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { writeConfig } = await import("../lib/config.ts");
const { providers } = await import("../lib/server/agent.ts");
const runs = await import("../lib/server/runs.ts");
const store = await import("../lib/server/project-store.ts");
const { writeProject } = await import("../lib/projects-fs.ts");
const { defaultProject } = await import("../lib/types.ts");
const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");

/** A project on `model` whose worker holds `session`, with one todo ticket. */
function project(t: TestContext, model: string, session: string): string {
  const dir = fs.mkdtempSync(path.join(home, "project-"));
  t.after(async () => {
    runs.registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
  });
  writeConfig({ model });
  writeProject(dir, {
    ...defaultProject("Expired", dir),
    workers: [{ id: "w", n: 1, description: "Theme", sessionId: session }],
    tickets: [{ id: "t", title: "Yellow bar", description: "", files: [], status: "todo", workerId: "w", log: [] }],
  });
  return dir;
}

/** Point `envVar` at a fake CLI running `script` (with `args`, `prompt` and
 * `emit`); returns the arguments and prompt of each launch. */
function fakeCli(t: TestContext, envVar: string, script: string) {
  const calls = path.join(fs.mkdtempSync(path.join(home, "cli-")), "calls.jsonl");
  const cli = path.join(path.dirname(calls), "fake.cjs");
  fs.writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => prompt += chunk);
process.stdin.on("end", () => {
  if (!prompt) prompt = args.at(-1);
  require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt }) + "\\n");
  ${script}
});`, { mode: 0o700 });
  const previous = process.env[envVar];
  process.env[envVar] = cli;
  t.after(() => {
    if (previous === undefined) delete process.env[envVar];
    else process.env[envVar] = previous;
  });
  return () => fs.readFileSync(calls, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
}

/** The run landed in review on `fresh`, having first resumed `old` with the
 * usual prompt and then sent the first-ticket one. */
function assertFreshStart(dir: string, sent: { resumed?: string; prompt: string }[], old: string, fresh: string) {
  const project = store.getProject(dir)!;
  const ticket = project.tickets[0];
  assert.equal(ticket.status, "review");
  assert.deepEqual(sent.map((c) => c.resumed), [old, undefined]);
  assert.match(sent[0].prompt, /this is a new ticket/);
  assert.doesNotMatch(sent[1].prompt, /this is a new ticket/);
  assert.match(sent[1].prompt, /## Ticket: Yellow bar/);
  assert.equal(project.workers[0].sessionId, fresh);
  assert.equal(ticket.sessionId, fresh);
  assert.deepEqual(ticket.log.filter((e) => e.kind === "error"), []);
  assert.equal(ticket.log.filter((e) => e.kind === "info" && /expired/.test(e.text)).length, 1);
}

test("a Claude worker whose conversation expired starts a new one in the same run", async (t) => {
  const dir = project(t, "claude-opus-5", "claude:old");
  // What the Claude provider yields when the CLI no longer has the session.
  const calls: AgentRequest[] = [];
  t.mock.method(providers.claude, "stream", async function* (req: AgentRequest): AsyncGenerator<AgentEvent> {
    calls.push(req);
    if (req.sessionId) {
      yield { type: "result", ok: false, text: "Agent stopped: error_during_execution" };
      yield { type: "error", message: "Error: Claude Code returned an error result: No conversation found with session ID: old" };
      return;
    }
    yield { type: "init", sessionId: "claude:new" };
    yield { type: "result", ok: true, text: "Made the bar yellow." };
  });

  await runs.runTicket(dir, "t");
  assertFreshStart(dir, calls.map((c) => ({ resumed: c.sessionId, prompt: c.prompt })), "claude:old", "claude:new");
});

test("a Codex worker whose thread is gone starts a new one in the same run", async (t) => {
  const dir = project(t, "gpt-6-astra", "codex:7c1e0a52-0000-4000-8000-000000000000");
  // Codex 0.172 prints this on stderr and exits 1, with nothing on stdout.
  const calls = fakeCli(t, "AUTOPROJECT_CODEX_PATH", `
if (args[1] === "resume") {
  process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + args[2] + " (code -32600)\\n");
  process.exit(1);
}
emit({ type: "thread.started", thread_id: "thread-new" });
emit({ type: "item.completed", item: { type: "agent_message", text: "Made the bar yellow." } });
emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } });`);

  await runs.runTicket(dir, "t");
  const sent = calls().map(({ args, prompt }) => ({ resumed: args[1] === "resume" ? `codex:${args[2]}` : undefined, prompt }));
  assertFreshStart(dir, sent, "codex:7c1e0a52-0000-4000-8000-000000000000", "codex:thread-new");
});

test("a Gemini worker whose conversation is gone starts a new one instead of agy's silent one", async (t) => {
  const dir = project(t, "gemini-3.7-flash-high", "gemini:old");
  // agy 1.5 warns on stderr, then runs the prompt in a new conversation and succeeds.
  const calls = fakeCli(t, "AUTOPROJECT_AGY_PATH", `
const asked = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : undefined;
if (asked) process.stderr.write("warning: conversation \\"" + asked + "\\" not found\\n");
emit({ event: "init", conversation_id: "conversation-new" });
emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Made the bar yellow." } });
emit({ event: "result", result: { status: "SUCCESS", response: "Made the bar yellow." } });`);

  await runs.runTicket(dir, "t");
  const sent = calls().map(({ args, prompt }) => ({
    resumed: args.includes("--conversation") ? `gemini:${args[args.indexOf("--conversation") + 1]}` : undefined,
    prompt,
  }));
  assertFreshStart(dir, sent, "gemini:old", "gemini:conversation-new");
});

test("a Codex usage limit fails the run but keeps the worker's conversation", async (t) => {
  const dir = project(t, "gpt-6-astra", "codex:thread-old");
  const limit = "You've hit your usage limit. Try again at 3:08 AM.";
  const calls = fakeCli(t, "AUTOPROJECT_CODEX_PATH", `
emit({ type: "thread.started", thread_id: args[2] });
emit({ type: "error", message: ${JSON.stringify(limit)} });
emit({ type: "turn.failed", error: { message: ${JSON.stringify(limit)} } });
process.exitCode = 1;`);

  await runs.runTicket(dir, "t");
  const { tickets: [ticket], workers: [worker] } = store.getProject(dir)!;
  assert.equal(ticket.status, "error");
  assert.equal(calls().length, 1);
  assert.equal(worker.sessionId, "codex:thread-old");
  assert.equal(ticket.sessionId, "codex:thread-old");
  assert.deepEqual(ticket.log.filter((e) => e.kind === "error").map((e) => e.text), [limit]);
});
