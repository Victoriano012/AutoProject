import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock, type TestContext } from "node:test";
import type { AgentEvent, AgentRequest } from "../lib/server/agent-types.ts";

/**
 * Update & restart swaps as soon as the update is built: whatever agent is at
 * work is cut short with no trace in its log and carried on by the next
 * server in its same conversation, told the update is live. Each test plays
 * both servers: the restart, then a cold load of what it left on disk.
 */

// config.ts and projects-fs.ts read the home directory on import: mock it first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-resume-"));
mock.method(os, "homedir", () => home);
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { writeConfig } = await import("../lib/config.ts");
const { providers } = await import("../lib/server/agent.ts");
const { restartNote, restartStatus, updateAndRestart } = await import("../lib/server/restart.ts");
const runs = await import("../lib/server/runs.ts");
const { sendToAgent } = await import("../lib/server/project-agent.ts");
const store = await import("../lib/server/project-store.ts");
const { readProject, writeProject } = await import("../lib/projects-fs.ts");
const { defaultProject } = await import("../lib/types.ts");
const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");
const { registry } = runs;

const server = (globalThis as unknown as { __autoprojectRestart: { phase: string } }).__autoprojectRestart;

/** A project where the server would find it on startup. */
function project(t: TestContext, tickets: Parameters<typeof writeProject>[1]["tickets"] = []): string {
  const base = path.join(home, "Documents", "personal");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "project-"));
  t.after(async () => {
    registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
  });
  writeConfig({ model: "claude-opus-5" });
  writeProject(dir, { ...defaultProject("Resume", dir), tickets });
  server.phase = "idle";
  return dir;
}

/** The agent: work on anything but the restart note runs a command and
 * starts a subagent, and is still at it when the restart cuts it short; the
 * note is answered at once. */
function fakeAgent(t: TestContext): AgentRequest[] {
  const calls: AgentRequest[] = [];
  t.mock.method(providers.claude, "stream", async function* (req: AgentRequest): AsyncGenerator<AgentEvent> {
    calls.push(req);
    yield { type: "init", sessionId: req.sessionId ?? `claude:s${calls.length}` };
    if (req.prompt.startsWith("AutoProject was restarted")) {
      yield { type: "text", text: "Finished." };
      yield { type: "result", ok: true, text: "Finished." };
      return;
    }
    yield { type: "tool", text: "Bash: sleep 60" };
    yield { type: "subagent", id: "toolu_1", description: "Write the tests", agentType: "worker" };
    await new Promise((resolve) => req.signal.addEventListener("abort", resolve, { once: true }));
    // What Claude says as an interrupt ends a turn and its background tasks.
    yield { type: "subagent-end", id: "toolu_1" };
    yield { type: "result", ok: false, text: "Agent stopped: error_during_execution" };
  });
  return calls;
}

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), what);
}

/** Update & restart on the old server, then the new one starting up. */
async function restart(dir: string): Promise<void> {
  let swapped = false;
  await updateAndRestart({ build: async () => null, swap: () => { swapped = true; } });
  assert.equal(swapped, true);
  await store.forget(dir);
  registry.requests.delete(dir);
  server.phase = "idle";
  runs.resumeAfterRestart();
}

const log = (dir: string, id: string) => store.getProject(dir)!.tickets.find((t) => t.id === id)!.log.map((e) => `${e.kind}: ${e.text.split("\n")[0]}`);
const traces = (lines: string[]) => lines.filter((l) => /^(error|info: Stopped|info: Taking)/.test(l) || /Agent stopped/.test(l));

test("a ticket at work carries on in its own session after the swap, as the same run", async (t) => {
  const dir = project(t, [{ id: "t", title: "Yellow bar", description: "", files: [], status: "todo", log: [] }]);
  const calls = fakeAgent(t);
  void runs.runTicket(dir, "t");
  await until(() => log(dir, "t").includes("tool: Bash: sleep 60"), "the run never got to work");

  await restart(dir);
  await until(() => store.getProject(dir)!.tickets[0].status === "review", "the run was not carried on");
  assert.deepEqual(calls.map((c) => c.sessionId), [undefined, "claude:s1"]);
  assert.equal(calls[1].prompt, restartNote());
  assert.deepEqual(log(dir, "t").filter((l) => !l.startsWith("user: ")), [
    "info: Run started",
    "tool: Bash: sleep 60",
    "text: Finished.",
  ]);
  assert.equal(log(dir, "t").filter((l) => l.startsWith("user: ")).length, 1, "no new prompt");
  assert.equal(store.getProject(dir)!.tickets[0].stats!.runs, 1);
  assert.equal(readProject(dir)!.resumes, undefined, "carried on once, never replayed");
});

test("feedback at work carries on after the swap and settles as feedback", async (t) => {
  const dir = project(t, [{ id: "t", title: "Yellow bar", description: "", files: [], status: "review", sessionId: "claude:old", log: [] }]);
  const calls = fakeAgent(t);
  void runs.sendFeedback(dir, "t", "Make it blue");
  await until(() => log(dir, "t").includes("tool: Bash: sleep 60"), "the feedback never got to work");

  let saved: ReturnType<typeof readProject> = null;
  await updateAndRestart({ build: async () => null, swap: () => { saved = readProject(dir); } });
  assert.deepEqual(saved!.resumes, { t: { prompt: restartNote(), sessionId: "claude:old", feedback: true } });
  assert.equal(saved!.tickets[0].status, "running");
  await store.forget(dir);
  server.phase = "idle";
  runs.resumeAfterRestart();

  await until(() => store.getProject(dir)!.tickets[0].status === "review", "the feedback was not carried on");
  assert.deepEqual(calls.map((c) => [c.sessionId, c.prompt.split("\n")[0]]), [
    ["claude:old", "Human review feedback on your work for this ticket:"],
    ["claude:old", restartNote().split("\n")[0]],
  ]);
  assert.deepEqual(traces(log(dir, "t")), []);
});

test("a ticket the person stopped during the swap stays stopped", async (t) => {
  const dir = project(t, [{ id: "t", title: "Yellow bar", description: "", files: [], status: "todo", log: [] }]);
  const calls = fakeAgent(t);
  void runs.runTicket(dir, "t");
  await until(() => log(dir, "t").includes("tool: Bash: sleep 60"), "the run never got to work");

  const restarting = updateAndRestart({ build: async () => null, swap: () => {} });
  await until(() => restartStatus().phase === "restarting", "never swapped");
  runs.stopTicket(dir, "t");
  await restarting;
  await store.forget(dir);
  server.phase = "idle";
  runs.resumeAfterRestart();
  runs.ensureLoaded(dir);
  await new Promise((r) => setTimeout(r, 50));

  const [ticket] = store.getProject(dir)!.tickets;
  assert.deepEqual([ticket.status, ticket.paused], ["todo", true]);
  assert.equal(calls.length, 1);
});

test("a chat turn carries on in its conversation, told which subagents the swap stopped", async (t) => {
  const dir = project(t);
  const calls = fakeAgent(t);
  const chat = () => store.getProject(dir)!.chat.map((e) => `${e.kind}: ${e.text}`);
  sendToAgent(dir, "act", "Build the cart");
  await until(() => chat().includes("tool: Bash: sleep 60"), "the turn never got to work");

  await restart(dir);
  await until(() => chat().includes("text: Finished.") && !registry.agents.has(dir), "the turn was not carried on");
  assert.deepEqual(calls.map((c) => c.sessionId), [undefined, "claude:s1"]);
  assert.equal(calls[1].prompt, restartNote(["Write the tests (worker)"]));
  // Read back, it is one turn that simply went on.
  assert.deepEqual(chat().map((l) => l.split("\n")[0]), [
    "user: Build the cart",
    "tool: Bash: sleep 60",
    "text: Finished.",
  ]);
  assert.deepEqual(runs.runState(dir).agent.requests, []);
});

test("the agent that ran the restart is told its update is live, so it does not run it again", () => {
  const note = restartNote();
  assert.match(note, /restarted to apply an update, and the update is now live/);
  assert.match(note, /If you ran `bin\/autoproject --restart` yourself, it has done its job; do not run it again/);
});
