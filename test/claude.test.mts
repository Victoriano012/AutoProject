import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../lib/server/agent-types.ts";
import { streamClaudeAgent } from "../lib/server/claude.ts";

/**
 * A Claude turn whose agent starts a background subagent, through the real
 * Agent SDK against a scripted CLI (fake-claude.mjs): the turn's input stays
 * open while the subagent runs, so a message is answered meanwhile, and closes
 * only once nothing is left running — the process never leaves an orphan for
 * the next resume to find.
 */

function fakeCli(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-fake-claude-"));
  const log = path.join(dir, "cli.jsonl");
  const saved = { path: process.env.AUTOPROJECT_CLAUDE_PATH, log: process.env.FAKE_CLAUDE_LOG };
  process.env.AUTOPROJECT_CLAUDE_PATH = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
  process.env.FAKE_CLAUDE_LOG = log;
  t.after(() => {
    for (const [key, value] of [["AUTOPROJECT_CLAUDE_PATH", saved.path], ["FAKE_CLAUDE_LOG", saved.log]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const seen = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, seen };
}

const turn = (dir: string, signal: AbortSignal) =>
  streamClaudeAgent({ workspaceDir: dir, prompt: "Start a worker", model: "claude-haiku-4-5-20251001", signal });

test("a turn waits for its background subagent, and hears a message while it runs", async (t) => {
  const cli = fakeCli(t);
  const events: AgentEvent[] = [];
  let push: ((text: string) => boolean) | undefined;
  for await (const ev of turn(cli.dir, new AbortController().signal)) {
    events.push(ev);
    if (ev.type === "input") push = ev.push;
    // The agent's turn is over but its subagent is not: the input is still open.
    if (ev.type === "result" && ev.text === "launched") assert.equal(push!("what is 2+2?"), true);
  }
  const said = events.flatMap((e) => (e.type === "text" || e.type === "result" ? [`${e.type}:${e.text}`] : []));
  assert.deepEqual(said, [
    "text:launched",
    "result:launched",
    "text:sleeping",
    "text:4",
    "result:4",
    "text:The worker finished.",
    "result:The worker finished.",
  ]);
  // The subagent ends with its task, not with the tool call that started it.
  const order = events.map((e) => e.type === "subagent-end" ? "end" : e.type === "result" ? e.text : "").filter(Boolean);
  assert.deepEqual(order, ["launched", "4", "end", "The worker finished."]);
  assert.deepEqual(cli.seen(), [
    { heard: "Start a worker", running: false },
    { heard: "what is 2+2?", running: true },
    { task: "completed" },
    { closed: true, running: false },
  ]);
  assert.equal(push!("too late"), false);
});

test("stopping while the agent waits on its subagent stops it, and the process ends", async (t) => {
  const cli = fakeCli(t);
  const stop = new AbortController();
  const events: AgentEvent[] = [];
  for await (const ev of turn(cli.dir, stop.signal)) {
    events.push(ev);
    // The agent's turn is over; only its subagent is at work.
    if (ev.type === "text" && ev.sub) stop.abort();
  }
  assert.ok(events.some((e) => e.type === "subagent-end" && e.id === "toolu_w"));
  assert.deepEqual(cli.seen(), [
    { heard: "Start a worker", running: false },
    { task: "stopped" },
    { closed: true, running: false },
  ]);
});
