import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeRunState } from "../lib/run-state.ts";
import type { Project, Ticket } from "../lib/types.ts";

/**
 * Who owns what between the browser and the server: the server owns the ticket
 * set and every run-produced field, the browser owns what the person typed.
 * A snapshot merge must never let one side overwrite the other's fields.
 */

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  status: "todo",
  log: [],
  ...p,
});
const p = (tickets: Ticket[], over: Partial<Project> = {}): Project => ({
  name: "p",
  description: "",
  workspaceDir: "/tmp/p",
  notes: [],
  tickets,
  workers: [],
  chat: [],
  ...over,
});

test("the browser keeps its own fields, the server keeps the run's", () => {
  const merged = mergeRunState(
    p([
      t({
        id: "a",
        title: "renamed here",
        description: "typed here",
        files: ["src/a.ts"],
        paused: true,
        status: "todo",
        log: [],
      }),
    ]),
    p([
      t({
        id: "a",
        title: "old name",
        status: "running",
        statusChangedAt: 42,
        sessionId: "s1",
        resultSummary: "done it",
        log: [{ ts: 1, kind: "info", text: "from the run" }],
      }),
    ])
  );
  const a = merged.tickets[0];
  assert.equal(a.title, "renamed here");
  assert.equal(a.description, "typed here");
  assert.deepEqual(a.files, ["src/a.ts"]);
  assert.equal(a.paused, true);
  assert.equal(a.status, "running");
  assert.equal(a.statusChangedAt, 42);
  assert.equal(a.sessionId, "s1");
  assert.equal(a.resultSummary, "done it");
  assert.equal(a.log.length, 1);
});

test("a ticket only the server knows survives: the project agent added it", () => {
  const merged = mergeRunState(p([t({ id: "a" })]), p([t({ id: "a" }), t({ id: "new" })]));
  assert.deepEqual(
    merged.tickets.map((x) => x.id),
    ["a", "new"]
  );
});

test("a ticket only the browser knows is dropped: the server removed it", () => {
  const warn = console.warn;
  console.warn = () => {}; // the merge notes the stale tab; not the point here
  try {
    const merged = mergeRunState(p([t({ id: "a" }), t({ id: "gone" })]), p([t({ id: "a" })]));
    assert.deepEqual(
      merged.tickets.map((x) => x.id),
      ["a"]
    );
  } finally {
    console.warn = warn;
  }
});

test("the server's order is the board's order", () => {
  const merged = mergeRunState(
    p([t({ id: "b" }), t({ id: "a" })]),
    p([t({ id: "a" }), t({ id: "b" })])
  );
  assert.deepEqual(
    merged.tickets.map((x) => x.id),
    ["a", "b"]
  );
});

test("the conversation and the agent's session come from the server", () => {
  const merged = mergeRunState(
    p([], { chat: [], notes: ["use pnpm"], description: "mine" }),
    p([], {
      chat: [{ ts: 1, kind: "user", text: "hi", mode: "panel" }],
      agentSessionId: "agent-1",
      notes: [],
      description: "theirs",
    })
  );
  assert.equal(merged.chat.length, 1);
  assert.equal(merged.agentSessionId, "agent-1");
  // Project-level user fields stay the browser's.
  assert.deepEqual(merged.notes, ["use pnpm"]);
  assert.equal(merged.description, "mine");
});
