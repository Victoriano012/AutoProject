import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ADD_TICKETS_SHAPE } from "../lib/server/board-tools.ts";
import { panelPreamble, systemAppend } from "../lib/server/project-agent.ts";
import { ticketPrompt } from "../lib/server/runs.ts";
import type { Project, Ticket } from "../lib/types.ts";

/**
 * The words the project agent and the ticket agents are given, as pure
 * functions: what a ticket prompt carries from the project, what a panel turn
 * is told about tickets, and the shape the board tool accepts.
 */

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  status: "todo",
  log: [],
  ...p,
});
const p = (over: Partial<Project> = {}): Project => ({
  name: "Shop",
  description: "An online shop.",
  workspaceDir: "/tmp/shop",
  notes: [],
  tickets: [],
  workers: [],
  chat: [],
  ...over,
});

test("a ticket prompt carries the project's standing instructions", () => {
  const ticket = t({ id: "a", title: "Add a cart", description: "Build the cart page." });
  const withNotes = ticketPrompt(
    p({ notes: ["Always use pnpm.", "Never touch /legacy."], tickets: [ticket] }),
    ticket
  );
  assert.match(withNotes, /Standing instructions for this project \(always apply\):/);
  assert.match(withNotes, /- Always use pnpm\./);
  assert.match(withNotes, /- Never touch \/legacy\./);
  assert.match(withNotes, /Build the cart page\./);
  // No notes, no section: an empty heading would read as an instruction lost.
  const bare = ticketPrompt(p({ tickets: [ticket] }), ticket);
  assert.doesNotMatch(bare, /Standing instructions/);
});

test("a panel turn is told the granularity rules and the board tool", () => {
  const text = panelPreamble(p({ tickets: [t({ id: "open" }), t({ id: "done", status: "done" })] }), "Add a cart");
  assert.match(text, /^MODE: PANEL/);
  assert.match(text, /Prefer fewer, larger tickets/);
  assert.match(text, /tightly coupled .* is ONE ticket/);
  assert.match(text, /`files` lists every workspace-relative path/);
  assert.match(text, /`worker` says who runs the ticket/);
  assert.match(text, /Do not modify files in this mode/);
  assert.match(text, /Human:\nAdd a cart$/);
  // The board state names the unsolved tickets only.
  assert.match(text, /- open \[todo\]/);
  assert.doesNotMatch(text, /- done \[done\]/);
  // The workers, by the number the planner names them with.
  assert.match(text, /There are no workers yet/);
  const staffed = panelPreamble(
    p({ workers: [{ id: "w1", n: 1, description: "Checkout flow" }] }),
    "Add a cart"
  );
  assert.match(staffed, /- #1 — Checkout flow/);
  // The tool names as the model sees them live in the stable role text.
  assert.match(systemAppend(p()), /mcp__board__add_tickets/);
  assert.match(systemAppend(p()), /mcp__board__set_notes/);
});

test("the board tool accepts an empty list and insists on files and a worker", () => {
  const schema = z.object(ADD_TICKETS_SHAPE);
  assert.equal(schema.safeParse({ tickets: [] }).success, true);
  const cart = { title: "Cart", description: "Build it.", files: ["src/cart.tsx"] };
  assert.equal(
    schema.safeParse({ tickets: [{ ...cart, worker: { existing: 1 } }] }).success,
    true
  );
  assert.equal(
    schema.safeParse({ tickets: [{ ...cart, worker: { new: "Checkout flow" } }] }).success,
    true
  );
  assert.equal(schema.safeParse({ tickets: [cart] }).success, false);
  assert.equal(
    schema.safeParse({ tickets: [{ title: "Cart", description: "Build it." }] }).success,
    false
  );
});

test("a ticket prompt names the worker, and its history once it has one", () => {
  const worker = { id: "w1", n: 2, description: "Checkout flow" };
  const ticket = t({ id: "a", title: "Add a cart", workerId: "w1" });
  const fresh = ticketPrompt(p({ workers: [worker], tickets: [ticket] }), ticket);
  assert.match(fresh, /You are worker #2 \(Checkout flow\)\./);
  assert.doesNotMatch(fresh, /Earlier tickets in this conversation/);
  const seasoned = ticketPrompt(
    p({ workers: [{ ...worker, sessionId: "claude:s1" }], tickets: [ticket] }),
    ticket
  );
  assert.match(seasoned, /Earlier tickets in this conversation are done; this is a new ticket/);
  // A ticket from before workers is told nothing about them.
  const legacy = t({ id: "b" });
  assert.doesNotMatch(ticketPrompt(p({ tickets: [legacy] }), legacy), /worker/);
});

test("messages queue behind a running turn, in order, and cancelling drops one", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry, runState } = await import("../lib/server/runs.ts");
  const { cancelRequest, sendToAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-agent-"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeProject(dir, defaultProject("Queue", dir));
  const events: string[] = [];
  const unsubscribe = store.subscribe(dir, (e) => events.push(e.type));
  // A turn in progress: nothing sent now may start, and the agent SDK is never reached.
  registry.agents.set(dir, new AbortController());
  try {
    const a = sendToAgent(dir, "panel", "Add a cart")!;
    const b = sendToAgent(dir, "panel", "Add checkout")!;
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.text, r.state]),
      [["Add a cart", "queued"], ["Add checkout", "queued"]]
    );
    // Nothing waiting was said to the agent yet; every change told the feed.
    assert.equal(store.getProject(dir)!.chat.length, 0);
    assert.ok(events.includes("agent"));

    cancelRequest(dir, a.id);
    assert.deepEqual(runState(dir).agent.requests.map((r) => r.id), [b.id]);
    cancelRequest(dir, b.id);
    assert.deepEqual(runState(dir).agent.requests, []);
    assert.equal(registry.agents.has(dir), true); // the live turn is not the queue's to stop
  } finally {
    unsubscribe();
    registry.agents.delete(dir);
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat message reaches a running chat turn at once; otherwise it waits like the rest", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry, runState } = await import("../lib/server/runs.ts");
  const { sendToAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-agent-"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeProject(dir, defaultProject("Inject", dir));
  const heard: string[] = [];
  // An act turn in progress whose CLI takes messages mid-turn.
  registry.agents.set(dir, new AbortController());
  registry.agentMode.set(dir, "act");
  registry.inputs.set(dir, (text) => (heard.push(text), true));
  try {
    assert.equal(sendToAgent(dir, "act", "Also d.txt"), null);
    assert.deepEqual(heard, ["Also d.txt"]);
    assert.deepEqual(runState(dir).agent.requests, []);
    // Said in the transcript the moment it was sent, as the agent hears it.
    assert.deepEqual(
      store.getProject(dir)!.chat.map((c) => [c.kind, c.mode, c.text]),
      [["user", "act", "Also d.txt"]]
    );
    // A board message never jumps into the chat turn.
    const panel = sendToAgent(dir, "panel", "Add a cart")!;
    assert.equal(panel.state, "queued");
    assert.deepEqual(heard, ["Also d.txt"]);
    // A turn that is over (or a CLI with no way in) sends it to the queue, unsaid.
    registry.inputs.set(dir, () => false);
    const late = sendToAgent(dir, "act", "And e.txt")!;
    assert.equal(late.state, "queued");
    assert.equal(store.getProject(dir)!.chat.length, 1);
    // So does a chat message while the board's turn is the one running.
    registry.inputs.set(dir, (text) => (heard.push(text), true));
    registry.agentMode.set(dir, "panel");
    assert.equal(sendToAgent(dir, "act", "And f.txt")!.state, "queued");
    assert.deepEqual(heard, ["Also d.txt"]);
  } finally {
    registry.agents.delete(dir);
    registry.agentMode.delete(dir);
    registry.inputs.delete(dir);
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Poll until the condition holds; the dispatch it waits for crosses a
 * dynamic import and the queue's own microtasks. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(ok(), what);
}

/** Take the process's only run slot, so a dispatched turn parks on the limiter
 * instead of reaching the agent SDK: the queue's behaviour is observable (the
 * request goes "running") with nothing actually run. */
async function holdEveryRunSlot(): Promise<() => void> {
  const { runLimiter } = await import("../lib/server/run-limiter.ts");
  const { providerForModel } = await import("../lib/server/model-settings.ts");
  const { selectedModel } = await import("../lib/config.ts");
  const previous = process.env.AUTOPROJECT_MAX_RUNS;
  process.env.AUTOPROJECT_MAX_RUNS = "1";
  const release = await runLimiter.acquire(providerForModel(selectedModel()), new AbortController().signal);
  return () => {
    release();
    if (previous === undefined) delete process.env.AUTOPROJECT_MAX_RUNS;
    else process.env.AUTOPROJECT_MAX_RUNS = previous;
  };
}

test("pressing run re-runs a failed request; the board's own resume does not", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry, runProject, runState } = await import("../lib/server/runs.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-agent-"));
  writeProject(dir, defaultProject("Revive", dir));
  const releaseSlot = await holdEveryRunSlot();
  registry.requests.set(dir, [
    { id: "r1", mode: "panel", text: "Add a cart", state: "error", error: "boom" },
    { id: "r2", mode: "panel", text: "Add checkout", state: "queued" },
  ]);
  try {
    // The automatic scheduler resumes: a request that failed stays failed, or
    // one failing every time would be retried for as long as the board is open.
    await runProject(dir, true);
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.id, r.state]),
      [["r1", "error"], ["r2", "queued"]]
    );

    // Pressing run is the person saying "go" about everything they asked for.
    await runProject(dir, false);
    await until(() => registry.agents.has(dir), "the revived request was never dispatched");
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.id, r.state, r.error]),
      [["r1", "running", undefined], ["r2", "queued", undefined]]
    );
    // Persisted too, so the stack survives the next load in the same order.
    assert.deepEqual(store.getProject(dir)!.agentRequests!.map((r) => r.id), ["r1", "r2"]);
  } finally {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    releaseSlot();
    registry.active.delete(dir);
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a request left queued by a restart is dispatched when the project loads", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { ensureLoaded, registry, runState } = await import("../lib/server/runs.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-restart-"));
  // project.json as the dead process left it: one turn mid-flight, one waiting.
  writeProject(dir, {
    ...defaultProject("Restart", dir),
    agentRequests: [
      { id: "r1", mode: "panel", text: "Add a cart", state: "running" },
      { id: "r2", mode: "panel", text: "Add checkout", state: "queued" },
    ],
  });
  const releaseSlot = await holdEveryRunSlot();
  registry.requests.delete(dir);
  try {
    ensureLoaded(dir);
    await until(() => registry.agents.has(dir), "the queued request was never dispatched");
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.id, r.state]),
      // The interrupted turn waits for the person; the one never dispatched runs.
      [["r1", "error"], ["r2", "running"]]
    );
    assert.match(runState(dir).agent.requests[0].error!, /Server restarted/);
  } finally {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    releaseSlot();
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the running request keeps it in the stack, text and all", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { ensureLoaded, registry, runState } = await import("../lib/server/runs.ts");
  const { sendToAgent, stopAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-stopped-"));
  writeProject(dir, defaultProject("Stopped", dir));
  const releaseSlot = await holdEveryRunSlot();
  try {
    const sent = sendToAgent(dir, "panel", "Add a cart")!;
    await until(() => registry.agents.has(dir), "the request was never dispatched");

    stopAgent(dir);
    await registry.agentTasks.get(dir);
    // Halted, not deleted: the person's words are still there to retry or take back.
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.id, r.state, r.text, r.error]),
      [[sent.id, "stopped", "Add a cart", undefined]]
    );

    // Through project.json and a restart: the stack reads back the same, and
    // a stopped request is not something a load may start on its own.
    await store.forget(dir);
    registry.requests.delete(dir);
    ensureLoaded(dir);
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.id, r.state, r.text]),
      [[sent.id, "stopped", "Add a cart"]]
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(registry.agents.has(dir), false);
  } finally {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    releaseSlot();
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the project keeps the whole stack stopped, and run sends it again", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry, runProject, runState, stopProject } = await import("../lib/server/runs.ts");
  const { sendToAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-stopall-"));
  writeProject(dir, defaultProject("Stop all", dir));
  const releaseSlot = await holdEveryRunSlot();
  const stack = () => runState(dir).agent.requests.map((r) => [r.id, r.state, r.text]);
  try {
    const first = sendToAgent(dir, "panel", "Add a cart")!;
    await until(() => registry.agents.has(dir), "the first request was never dispatched");
    const second = sendToAgent(dir, "panel", "Add checkout")!;

    stopProject(dir, true);
    // Nothing is thrown away, and the stack says so at once — the one running
    // and the one still waiting both stopped, in place.
    assert.deepEqual(stack(), [
      [first.id, "stopped", "Add a cart"],
      [second.id, "stopped", "Add checkout"],
    ]);
    await registry.agentTasks.get(dir);
    await new Promise((r) => setTimeout(r, 20));
    // Stop means stop: the queue does not move on to the next one by itself.
    assert.deepEqual(stack(), [
      [first.id, "stopped", "Add a cart"],
      [second.id, "stopped", "Add checkout"],
    ]);
    assert.equal(registry.agents.has(dir), false);
    assert.deepEqual(store.getProject(dir)!.agentRequests!.map((r) => r.state), ["stopped", "stopped"]);

    // An automatic resume never lifts the person's stop.
    await runProject(dir, true);
    assert.deepEqual(stack().map((r) => r[1]), ["stopped", "stopped"]);

    // Pressing run does, the same way it un-pauses a stopped ticket.
    await runProject(dir, false);
    await until(() => registry.agents.has(dir), "run never sent the stopped requests again");
    assert.deepEqual(stack(), [
      [first.id, "running", "Add a cart"],
      [second.id, "queued", "Add checkout"],
    ]);
  } finally {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    releaseSlot();
    registry.active.delete(dir);
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sent message is marked heard only when the agent is told it, and that survives a restart", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { ensureLoaded, notifyAgent, registry, runState } = await import("../lib/server/runs.ts");
  const { sendToAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-heard-"));
  writeProject(dir, defaultProject("Heard", dir));
  const releaseSlot = await holdEveryRunSlot();
  const stack = () => runState(dir).agent.requests.map((r) => [r.text, r.state, r.heard ?? false]);
  try {
    sendToAgent(dir, "act", "Rename the file");
    await until(() => registry.agents.has(dir), "the request was never dispatched");
    // The window the chat view used to show nothing: dispatched and waiting
    // for capacity, so "running", but not a word of it said to the agent yet.
    assert.deepEqual(stack(), [["Rename the file", "running", false]]);
    assert.equal(store.getProject(dir)!.chat.length, 0);

    // The fast path hands a chat message to the live turn and makes no
    // request at all: it is in the transcript, so there is nothing pending to
    // draw a second bubble from.
    registry.inputs.set(dir, () => true);
    assert.equal(sendToAgent(dir, "act", "And the tests"), null);
    registry.inputs.delete(dir);
    assert.deepEqual(stack(), [["Rename the file", "running", false]]);
    assert.deepEqual(store.getProject(dir)!.chat.map((c) => c.text), ["And the tests"]);

    // What the turn does once the agent is finally told it (see pumpOnce).
    registry.requests.get(dir)![0].heard = true;
    notifyAgent(dir);
    assert.deepEqual(stack(), [["Rename the file", "running", true]]);

    // Through project.json and a restart: the interrupted turn is parked for
    // a retry, and still known to have reached the transcript — the chat
    // shows the line it wrote, not a pending bubble repeating it.
    await store.forget(dir);
    registry.requests.delete(dir);
    ensureLoaded(dir);
    assert.deepEqual(stack(), [["Rename the file", "error", true]]);
  } finally {
    registry.agents.get(dir)?.abort();
    await registry.agentTasks.get(dir);
    releaseSlot();
    registry.requests.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tickets the planner adds are carried on the chat entry, with their titles", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry } = await import("../lib/server/runs.ts");
  const { addTicketsToBoard } = await import("../lib/server/board-tools.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir = mkdtempSync(join(tmpdir(), "autoproject-added-"));
  writeProject(dir, defaultProject("Added", dir));
  // The board would start the new cards; this test is about what it says.
  registry.loops.add(dir);
  try {
    const added = addTicketsToBoard(dir, [
      { title: "Add a cart", description: "Build the cart page.", files: ["src/cart.tsx"] },
      { title: "Add checkout", description: "Take the money.", files: ["src/checkout.tsx"] },
    ]);
    const entry = store.getProject(dir)!.chat.at(-1)!;
    assert.deepEqual(entry.tickets, [
      { id: added[0].id, title: "Add a cart" },
      { id: added[1].id, title: "Add checkout" },
    ]);
    // The text stays the entry's own words, for the download and for an entry
    // whose cards are gone.
    assert.match(entry.text, /Add a cart; Add checkout/);

    // Through project.json: a transcript read back still has every title.
    await store.forget(dir);
    assert.deepEqual(
      store.getProject(dir)!.chat.at(-1)!.tickets,
      [
        { id: added[0].id, title: "Add a cart" },
        { id: added[1].id, title: "Add checkout" },
      ]
    );
  } finally {
    registry.loops.delete(dir);
    await store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
