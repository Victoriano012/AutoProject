import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock, type TestContext } from "node:test";

/**
 * A chat message sent while the project agent works on Codex or Gemini reaches
 * it at once, as on Claude: Codex adds it to the running turn, agy's turn is
 * cut and its conversation goes on with it. Either way the chat reads as if it
 * was simply delivered — the earlier actions stay, nothing says the turn was
 * stopped — and a real Stop still reads as one.
 */

// config.ts reads the home directory on import: mock it first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-mid-turn-"));
mock.method(os, "homedir", () => home);
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { fakeCodex } = await import("./fake-codex.mts");
const { writeConfig } = await import("../lib/config.ts");
const store = await import("../lib/server/project-store.ts");
const { registry, runState } = await import("../lib/server/runs.ts");
const { sendToAgent, stopAgent } = await import("../lib/server/project-agent.ts");
const { writeProject } = await import("../lib/projects-fs.ts");
const { defaultProject } = await import("../lib/types.ts");
const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");

function project(t: TestContext, model: string): string {
  const dir = fs.mkdtempSync(path.join(home, "project-"));
  t.after(async () => {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
  });
  writeConfig({ model });
  writeProject(dir, defaultProject("Mid-turn", dir));
  return dir;
}

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), what);
}

const chat = (dir: string) => store.getProject(dir)!.chat.map((e) => [e.kind, e.text]);

/** A fake agy: a new conversation says a line, starts `sleep 60` and is half
 * way through its next sentence when it hears nothing more; SIGINT ends it as
 * agy does. A resumed one answers. Returns each launch's arguments. */
function fakeAgy(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(home, "agy-"));
  const calls = path.join(dir, "calls.jsonl");
  const cli = path.join(dir, "agy.cjs");
  fs.writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const step = (s) => emit({ event: "step_update", step_update: s });
const resumed = args.includes("--conversation");
emit({ event: "init", conversation_id: "conv-1" });
if (resumed) {
  step({ step_index: 9, state: "DONE", step_type: "agent_response", text_delta: "4" });
  emit({ event: "result", result: { status: "SUCCESS", response: "4" } });
} else {
  step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "On it." });
  step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } } });
  step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Halfway thr" });
  process.on("SIGINT", () => {
    emit({ event: "result", result: { status: "ERROR", error: "interrupted" } });
    process.exit(1);
  });
  setInterval(() => {}, 1000);
}`, { mode: 0o700 });
  const previous = process.env.AUTOPROJECT_AGY_PATH;
  process.env.AUTOPROJECT_AGY_PATH = cli;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOPROJECT_AGY_PATH;
    else process.env.AUTOPROJECT_AGY_PATH = previous;
  });
  return () => fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
}

test("Codex: a message mid-turn joins the running turn at once", async (t) => {
  const dir = project(t, "gpt-6-astra");
  const sent = fakeCodex(t, `
if (!steering) tool("sleep 60");
else { say("4"); complete(); }`);

  sendToAgent(dir, "act", "Run sleep 60");
  await until(() => chat(dir).some(([kind]) => kind === "tool"), "the turn never started its command");
  assert.equal(sendToAgent(dir, "act", "what is 2+2?"), null, "delivered, not queued");
  await registry.agentTasks.get(dir);

  // Both messages went to the one turn of the one thread, the second told as sent mid-turn.
  const [first, second] = sent();
  assert.match(first.text, /Run sleep 60$/);
  assert.match(second.text, /^The person sent this while you were working:\n\nwhat is 2\+2\?\n\nAnswer it now/);
  assert.equal(sent().length, 2);
  assert.deepEqual(chat(dir), [
    ["user", "Run sleep 60"],
    ["tool", "Bash: sleep 60"],
    ["user", "what is 2+2?"],
    ["text", "4"],
  ]);
  assert.deepEqual(runState(dir).agent.requests, []);
  assert.equal(store.getProject(dir)!.agentSessionId, "codex:thread-new");
});

test("Gemini: a message mid-turn cuts the step at work and the conversation goes on with it", async (t) => {
  const dir = project(t, "gemini-3.7-flash-high");
  const calls = fakeAgy(t);

  sendToAgent(dir, "act", "Run sleep 60");
  await until(() => chat(dir).some(([kind]) => kind === "tool"), "the turn never started its command");
  assert.equal(sendToAgent(dir, "act", "what is 2+2?"), null, "delivered, not queued");
  await registry.agentTasks.get(dir);

  // The same conversation, told the message and that its step was cut.
  const [first, second] = calls();
  assert.equal(first.includes("--conversation"), false);
  assert.equal(second[second.indexOf("--conversation") + 1], "conv-1");
  assert.match(second.at(-1)!, /^The person sent this while you were working, which stopped the step you were on:\n\nwhat is 2\+2\?\n\nAnswer it now/);
  // What happened stays; the half sentence, the interruption and the failure do not.
  assert.deepEqual(chat(dir), [
    ["user", "Run sleep 60"],
    ["text", "On it."],
    ["tool", "Bash: sleep 60"],
    ["user", "what is 2+2?"],
    ["text", "4"],
  ]);
  assert.deepEqual(runState(dir).agent.requests, []);
  assert.equal(store.getProject(dir)!.agentSessionId, "gemini:conv-1");
});

for (const [provider, model] of [["Codex", "gpt-6-astra"], ["Gemini", "gemini-3.7-flash-high"]] as const) {
  test(`${provider}: Stop still stops the turn, and says so`, async (t) => {
    const dir = project(t, model);
    const codex = provider === "Codex" ? fakeCodex(t, `tool("sleep 60");`) : undefined;
    if (!codex) fakeAgy(t);

    const req = sendToAgent(dir, "act", "Run sleep 60")!;
    await until(() => chat(dir).some(([kind]) => kind === "tool"), "the turn never started its command");
    stopAgent(dir);
    await registry.agentTasks.get(dir);

    assert.equal(chat(dir).at(-1)?.join(": "), "info: Stopped by user");
    assert.equal(chat(dir).some(([kind]) => kind === "error"), false);
    assert.deepEqual(runState(dir).agent.requests.map((r) => [r.id, r.state]), [[req.id, "stopped"]]);
    // Over: a message now waits for its own turn.
    assert.equal(registry.inputs.has(dir), false);
    // Codex is asked to stop the turn, which ends its commands with it; a
    // killed app-server would leave them running.
    if (codex) assert.deepEqual(codex().at(-1), { interrupted: "turn-1" });
  });
}
