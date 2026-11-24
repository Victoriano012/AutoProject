import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, AgentRequest } from "../lib/server/agent-types.ts";
import { startingSession, ticketPrompt } from "../lib/server/ticket-prompt.ts";
import { defaultProject, type Project, type Ticket, type Worker } from "../lib/types.ts";

const ticket = (id: string, extra: Partial<Ticket> = {}): Ticket => ({
  id, title: id, description: "", files: [], status: "todo", workerId: "w", log: [], ...extra,
});
const board = (worker: Partial<Worker>, tickets: Ticket[]): Project => ({
  ...defaultProject("P", "/tmp/p"),
  workers: [{ id: "w", n: 1, description: "Settings", sessionId: "claude:old", ...worker }],
  tickets,
});

test("a worker keeps its conversation until it is too big or has done too many tickets", () => {
  const done = (n: number) => Array.from({ length: n }, (_, i) => ticket(`d${i}`, { status: "done", sessionId: "claude:old" }));
  const next = ticket("next");
  assert.equal(startingSession(board({ contextTokens: 40_000 }, [...done(3), next]), next), "claude:old");
  assert.equal(startingSession(board({ contextTokens: 60_000 }, [next]), next), undefined);
  assert.equal(startingSession(board({}, [...done(4), next]), next), undefined);
  // Tickets from an earlier conversation do not count against this one.
  const older = done(4).map((t) => ({ ...t, sessionId: "claude:older" }));
  assert.equal(startingSession(board({}, [...older, next]), next), "claude:old");
});

test("a new conversation is told what the worker already did instead of being told it remembers", () => {
  const earlier = ticket("Icon button", { status: "done", sessionId: "claude:old", resultSummary: "Refresh is now an icon.\n\nMore." });
  const next = ticket("next");
  const kept = ticketPrompt(board({ contextTokens: 10_000 }, [earlier, next]), next);
  assert.match(kept, /this is a new ticket/);
  assert.doesNotMatch(kept, /Icon button/);
  const fresh = ticketPrompt(board({ contextTokens: 150_000 }, [earlier, next]), next);
  assert.doesNotMatch(fresh, /this is a new ticket/);
  assert.match(fresh, /- Icon button: Refresh is now an icon\.\n/);
});

test("an oversized worker conversation is replaced, and old tickets' feedback keeps their own", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-rotate-"));
  t.mock.method(os, "homedir", () => home);
  const dir = path.join(home, "project");
  fs.mkdirSync(dir);

  const { writeConfig } = await import("../lib/config.ts");
  const { providers } = await import("../lib/server/agent.ts");
  const runs = await import("../lib/server/runs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");
  t.after(async () => {
    runs.registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const calls: AgentRequest[] = [];
  t.mock.method(providers.claude, "stream", async function* (req: AgentRequest): AsyncGenerator<AgentEvent> {
    calls.push(req);
    yield { type: "init", sessionId: req.sessionId ?? "claude:new" };
    yield { type: "result", ok: true, text: "Done.", usage: { tokens: 1, contextTokens: 30_000 } };
  });

  writeConfig({ model: "claude-opus-5" });
  writeProject(dir, board({ contextTokens: 130_000 }, [
    ticket("old", { status: "review", sessionId: "claude:old", resultSummary: "Made the bar yellow." }),
    ticket("next"),
  ]));
  store.getProject(dir);

  await runs.runTicket(dir, "next");
  assert.equal(calls[0].sessionId, undefined);
  assert.match(calls[0].prompt, /- old: Made the bar yellow\./);
  let worker = store.getProject(dir)!.workers[0];
  assert.equal(worker.sessionId, "claude:new");
  assert.equal(worker.contextTokens, 30_000);

  await runs.sendFeedback(dir, "old", "Make it brighter");
  assert.equal(calls[1].sessionId, "claude:old");
  worker = store.getProject(dir)!.workers[0];
  assert.equal(worker.sessionId, "claude:new");
  assert.equal(worker.contextTokens, 30_000);
});
