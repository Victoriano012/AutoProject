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
