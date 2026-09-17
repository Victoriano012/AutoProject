import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { streamCodexAgent } from "../lib/server/codex.ts";
import { streamGeminiAgent } from "../lib/server/gemini.ts";
import { createCliSession } from "../lib/server/cli-process.ts";
import { addTicketsSchema, parsePlannedTickets, requestJsonSchema } from "../lib/board-schema.ts";
import type { AgentEvent, AgentRequest } from "../lib/server/agent-types.ts";

function fixture(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-cli-"));
  const executable = path.join(dir, "fake-cli.cjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${script}`, { mode: 0o700 });
  return { dir, executable, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function request(dir: string, model: string, overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { workspaceDir: dir, model, prompt: "Build a cart", signal: new AbortController().signal, ...overrides };
}

async function collect(events: AsyncGenerator<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

const capture = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const schemaFlag = args.indexOf('--output-schema') >= 0 ? '--output-schema' : '--json-schema';
const schemaPath = args[args.indexOf(schemaFlag) + 1];
const schema = args.includes(schemaFlag) ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : undefined;
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
`;

test("Codex fake CLI verifies stdin, structured output, usage, deduplicated tools and temp cleanup", async () => {
  const fixtureFiles = fixture(capture + `
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('captured.json', JSON.stringify({ args, schemaPath, schema, stdin }));
  console.log('non-JSON CLI banner'); console.log('null');
  emit({ type: 'thread.started', thread_id: 'thread-1' });
  const item = { type: 'command_execution', id: 'tool-1', command: 'pwd' };
  emit({ type: 'item.started', item }); emit({ type: 'item.completed', item });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: '{"tickets":[]}' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } });
});`);
  const previous = process.env.AUTOPROJECT_CODEX_PATH;
  process.env.AUTOPROJECT_CODEX_PATH = fixtureFiles.executable;
  try {
    const events = await collect(streamCodexAgent(request(fixtureFiles.dir, "gpt-6-astra", { outputSchema: requestJsonSchema })));
    assert.deepEqual(events.map((event) => event.type), ["init", "tool", "text", "result"]);
    assert.deepEqual(events.at(-1), { type: "result", ok: true, text: '{"tickets":[]}', structuredOutput: { tickets: [] }, usage: { tokens: 13 } });
    const saved = JSON.parse(fs.readFileSync(path.join(fixtureFiles.dir, "captured.json"), "utf8"));
    assert.equal(saved.stdin, "Build a cart");
    assert.deepEqual(saved.schema, requestJsonSchema);
    assert.equal(fs.existsSync(saved.schemaPath), false);
  } finally {
    if (previous === undefined) delete process.env.AUTOPROJECT_CODEX_PATH;
    else process.env.AUTOPROJECT_CODEX_PATH = previous;
    fixtureFiles.cleanup();
  }
});

test("Gemini fake CLI translates streamed text and explicit structured output", async () => {
  const fixtureFiles = fixture(capture + `
fs.writeFileSync('captured.json', JSON.stringify({ args, schemaPath, schema }));
emit({ event: 'init', conversation_id: 'conversation-1' });
emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Ready' } });
emit({ event: 'result', result: { status: 'SUCCESS', response: 'Ready', structured_output: { tickets: [] }, usage: { input_tokens: 9, output_tokens: 2 } } });`);
  const previous = process.env.AUTOPROJECT_AGY_PATH;
  process.env.AUTOPROJECT_AGY_PATH = fixtureFiles.executable;
  try {
    const events = await collect(streamGeminiAgent(request(fixtureFiles.dir, "gemini-3.7-flash-high", { reasoningEffort: "low", outputSchema: requestJsonSchema })));
    assert.deepEqual(events[0], { type: "init", sessionId: "gemini:conversation-1" });
    assert.deepEqual(events.at(-1), { type: "result", ok: true, text: "Ready", structuredOutput: { tickets: [] }, usage: { tokens: 11 } });
    const saved = JSON.parse(fs.readFileSync(path.join(fixtureFiles.dir, "captured.json"), "utf8"));
    assert.ok(saved.args.includes("gemini-3.7-flash-low"));
    assert.deepEqual(saved.args.slice(-2), ["--print", "Build a cart"]);
    assert.equal(fs.existsSync(saved.schemaPath), false);
  } finally {
    if (previous === undefined) delete process.env.AUTOPROJECT_AGY_PATH;
    else process.env.AUTOPROJECT_AGY_PATH = previous;
    fixtureFiles.cleanup();
  }
});

test("missing CLI becomes a helpful event, including structured-output requests", async () => {
  const fixtureFiles = fixture("");
  const previous = process.env.AUTOPROJECT_CODEX_PATH;
  process.env.AUTOPROJECT_CODEX_PATH = path.join(fixtureFiles.dir, "missing");
  try {
    const events = await collect(streamCodexAgent(request(fixtureFiles.dir, "gpt-6-astra", { outputSchema: requestJsonSchema })));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    if (events[0].type === "error") assert.match(events[0].message, /Codex CLI was not found/);
  } finally {
    if (previous === undefined) delete process.env.AUTOPROJECT_CODEX_PATH;
    else process.env.AUTOPROJECT_CODEX_PATH = previous;
    fixtureFiles.cleanup();
  }
});

test("CLI cancellation escalates and waits for actual exit; iterator cleanup does too", async () => {
  const fixtureFiles = fixture(`process.on('SIGINT', () => {}); console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000);`);
  try {
    for (const abort of [true, false]) {
      const controller = new AbortController();
      const cli = await createCliSession(request(fixtureFiles.dir, "gpt-6-astra", { signal: controller.signal }), {
        label: "Test", executable: process.execPath, args: () => [fixtureFiles.executable], killAfterMs: 20,
      });
      const init = await cli.events.next();
      const pid = init.value!.pid as number;
      if (abort) controller.abort();
      await cli.close();
      assert.equal((await cli.exit).signal, "SIGKILL");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally { fixtureFiles.cleanup(); }
});

test("provider iterator early return waits for child shutdown", async () => {
  const fixtureFiles = fixture(`process.on('SIGINT', () => setTimeout(() => process.exit(0), 20)); console.log(JSON.stringify({type:'thread.started', thread_id:String(process.pid)})); setInterval(() => {}, 1000);`);
  const previous = process.env.AUTOPROJECT_CODEX_PATH;
  process.env.AUTOPROJECT_CODEX_PATH = fixtureFiles.executable;
  try {
    const events = streamCodexAgent(request(fixtureFiles.dir, "gpt-6-astra"));
    const first = await events.next();
    assert.equal(first.value?.type, "init");
    const pid = Number(first.value?.type === "init" ? first.value.sessionId.replace("codex:", "") : 0);
    await events.return(undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (previous === undefined) delete process.env.AUTOPROJECT_CODEX_PATH;
    else process.env.AUTOPROJECT_CODEX_PATH = previous;
    fixtureFiles.cleanup();
  }
});

test("one planner schema validates all providers and generates their JSON contract", () => {
  const ticket = { title: "Cart", description: "Build it", files: ["src/cart.ts"], worker: { existing: 1 } };
  assert.deepEqual(parsePlannedTickets({ tickets: [ticket] }), [ticket]);
  assert.deepEqual(parsePlannedTickets({ tickets: [] }), []);
  assert.throws(() => parsePlannedTickets({ tickets: [{ ...ticket, worker: { existing: 0 } }] }));
  assert.throws(() => parsePlannedTickets({ tickets: [{ ...ticket, files: undefined }] }));
  assert.throws(() => parsePlannedTickets({ tickets: [{ ...ticket, unexpected: true }] }));
  assert.equal(addTicketsSchema.safeParse({ tickets: [{ ...ticket, worker: { new: "   " } }] }).success, false);
  assert.deepEqual(requestJsonSchema.required, ["tickets"]);
});
