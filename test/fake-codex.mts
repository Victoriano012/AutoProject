import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Write a stand-in for `codex app-server` and point AUTOPROJECT_CODEX_PATH at
 * it. It answers initialize and the thread request (`open` may answer that
 * otherwise, with `reply` or `fail`), and runs `turn` on each turn/start, with `text` the message, `resumed` the thread asked
 * for, `steering` when a turn is open (the message joins it, as in Codex), and
 * `emit`, `say`, `tool` and `complete` to answer. Returns the messages sent,
 * with the thread each run asked to resume.
 */
export function fakeCodex(t: TestContext, turn: string, open = `reply({ thread: { id: resumed ?? "thread-new" } });`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-fake-codex-"));
  const log = path.join(dir, "sent.jsonl");
  const cli = path.join(dir, "codex.cjs");
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const emit = (method, params) => send({ method, params });
let threadId, resumed, active, turns = 0;
const say = (text) => emit("item/completed", { threadId, item: { type: "agentMessage", id: "m" + Math.random(), text } });
const tool = (command) => emit("item/started", { threadId, item: { type: "commandExecution", id: "c" + Math.random(), command } });
const complete = (status = "completed", error = null) => {
  emit("thread/tokenUsage/updated", { threadId, tokenUsage: { last: { inputTokens: 10, outputTokens: 3 } } });
  emit("turn/completed", { threadId, turn: { id: active, status, error } });
  active = undefined;
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (result) => send({ id: m.id, result });
  const fail = (message) => send({ id: m.id, error: { code: -32600, message } });
  if (m.method === "initialize") reply({});
  else if (m.method === "thread/start" || m.method === "thread/resume") {
    resumed = m.params.threadId;
    ${open}
    threadId = resumed ?? "thread-new";
  } else if (m.method === "turn/start") {
    const text = m.params.input[0].text;
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resumed, text, outputSchema: m.params.outputSchema }) + "\\n");
    const steering = Boolean(active);
    if (!steering) active = "turn-" + ++turns;
    reply({ turn: { id: active } });
    if (!steering) emit("turn/started", { threadId, turn: { id: active } });
    ${turn}
  }
});
`, { mode: 0o700 });
  const previous = process.env.AUTOPROJECT_CODEX_PATH;
  process.env.AUTOPROJECT_CODEX_PATH = cli;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOPROJECT_CODEX_PATH;
    else process.env.AUTOPROJECT_CODEX_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { resumed?: string; text: string; outputSchema?: unknown })
    : [];
}
