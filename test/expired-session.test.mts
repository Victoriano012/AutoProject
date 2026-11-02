import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, AgentRequest } from "../lib/server/agent-types.ts";

test("a worker whose conversation expired starts a new one in the same run", async (t) => {
  // config.ts reads the home directory on import: mock it first.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-expired-"));
  t.mock.method(os, "homedir", () => home);
  const dir = path.join(home, "project");
  fs.mkdirSync(dir);

  const { writeConfig } = await import("../lib/config.ts");
  const { providers } = await import("../lib/server/agent.ts");
  const runs = await import("../lib/server/runs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");
  t.after(async () => {
    runs.registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
    fs.rmSync(home, { recursive: true, force: true });
  });

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

  writeConfig({ model: "claude-opus-5" });
  writeProject(dir, {
    ...defaultProject("Expired", dir),
    workers: [{ id: "w", n: 1, description: "Theme", sessionId: "claude:old" }],
    tickets: [{ id: "t", title: "Yellow bar", description: "", files: [], status: "todo", workerId: "w", log: [] }],
  });

  await runs.runTicket(dir, "t");
  const project = store.getProject(dir)!;
  const ticket = project.tickets[0];
  assert.equal(ticket.status, "review");
  assert.deepEqual(calls.map((c) => c.sessionId), ["claude:old", undefined]);
  assert.match(calls[0].prompt, /this is a new ticket/);
  assert.doesNotMatch(calls[1].prompt, /this is a new ticket/);
  assert.match(calls[1].prompt, /## Ticket: Yellow bar/);
  assert.equal(project.workers[0].sessionId, "claude:new");
  assert.equal(ticket.sessionId, "claude:new");
  assert.deepEqual(ticket.log.filter((e) => e.kind === "error"), []);
  assert.equal(ticket.log.filter((e) => e.kind === "info" && /expired/.test(e.text)).length, 1);
});
