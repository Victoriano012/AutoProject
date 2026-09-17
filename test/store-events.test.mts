import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { readProject, writeProject } from "../lib/projects-fs.ts";
import * as store from "../lib/server/project-store.ts";
import type { ProjectEvent } from "../lib/server/project-store.ts";
import { defaultProject, newTicket, type Project } from "../lib/types.ts";

/**
 * The server's project store, on a scratch project: what the live feed is
 * told when a run changes a status, when the project agent adds tickets, and
 * when either side of the conversation says something.
 */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-store-"));
test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function scratchProject(name: string) {
  const dir = path.join(SCRATCH, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeProject(dir, {
    ...defaultProject(name, dir),
    tickets: [newTicket({ id: "a", title: "A", statusChangedAt: 1 })],
  });
  const events: ProjectEvent[] = [];
  const unsubscribe = store.subscribe(dir, (e) => events.push(e));
  return { dir, events, unsubscribe };
}

test("a status change stamps statusChangedAt and publishes it", async () => {
  const { dir, events, unsubscribe } = scratchProject("status");
  try {
    const before = Date.now();
    store.updateTicket(dir, "a", (t) => ({ ...t, status: "running" }));
    const [e] = events;
    assert.equal(e.type, "ticket");
    if (e.type !== "ticket") return;
    assert.equal(e.id, "a");
    assert.equal(e.patch.status, "running");
    assert.ok((e.patch.statusChangedAt ?? 0) >= before);
    assert.equal(store.getProject(dir)!.tickets[0].statusChangedAt, e.patch.statusChangedAt);

    // A change that leaves the status alone does not re-stamp it.
    store.updateTicket(dir, "a", (t) => ({ ...t, resultSummary: "half way" }));
    const second = events[1];
    assert.equal(second.type, "ticket");
    if (second.type !== "ticket") return;
    assert.equal(second.patch.statusChangedAt, undefined);
    assert.equal(store.getProject(dir)!.tickets[0].statusChangedAt, e.patch.statusChangedAt);
  } finally {
    unsubscribe();
    await store.forget(dir);
  }
});

test("adding tickets publishes them, with ids, todo and stamped", async () => {
  const { dir, events, unsubscribe } = scratchProject("add");
  try {
    const before = Date.now();
    const added = store.addTickets(dir, [
      { title: "B", description: "Build B.", files: ["src/b.ts"] },
      { title: "C", description: "Build C." },
    ]);
    assert.equal(added.length, 2);
    // Their workers land first, so a tab can draw each card's badge at once.
    assert.equal(events[0].type, "workers");
    const e = events[1];
    assert.equal(e.type, "tickets");
    if (e.type !== "tickets") return;
    assert.deepEqual(e.removed, []);
    assert.deepEqual(
      e.added.map((t) => t.title),
      ["B", "C"]
    );
    for (const t of e.added) {
      assert.ok(t.id);
      assert.equal(t.status, "todo");
      assert.deepEqual(t.log, []);
      assert.ok((t.statusChangedAt ?? 0) >= before);
    }
    assert.deepEqual(e.added[0].files, ["src/b.ts"]);
    // On the board, after the ticket that was already there — and on disk.
    assert.deepEqual(
      store.getProject(dir)!.tickets.map((t) => t.title),
      ["A", "B", "C"]
    );
    await store.flush(dir);
    assert.equal(readProject(dir)!.tickets.length, 3);

    store.removeTickets(dir, [added[0].id]);
    const gone = events[2];
    assert.equal(gone.type, "tickets");
    if (gone.type !== "tickets") return;
    assert.deepEqual(gone.removed, [added[0].id]);
    assert.deepEqual(
      store.getProject(dir)!.tickets.map((t) => t.title),
      ["A", "C"]
    );
  } finally {
    unsubscribe();
    await store.forget(dir);
  }
});

test("the conversation publishes what was appended", async () => {
  const { dir, events, unsubscribe } = scratchProject("chat");
  try {
    const entries = [
      { kind: "user" as const, text: "Add a cart", ts: 1, mode: "panel" as const },
      { kind: "text" as const, text: "On it.", ts: 2, mode: "panel" as const },
    ];
    store.appendChat(dir, entries);
    assert.deepEqual(events, [{ type: "chat", entries }]);
    assert.deepEqual(store.getProject(dir)!.chat, entries);
    // Nothing to say, nothing said.
    store.appendChat(dir, []);
    assert.equal(events.length, 1);
  } finally {
    unsubscribe();
    await store.forget(dir);
  }
});

test("a planned ticket reuses the worker it names, or gets a new one", async () => {
  const { dir, events, unsubscribe } = scratchProject("workers");
  try {
    const [b, c, d, e, f] = store.addTickets(dir, [
      { title: "B", description: "", worker: { new: "Checkout flow" } },
      { title: "C", description: "", worker: { existing: 1 } },
      // A number nobody has, and nothing at all: a worker described by the ticket.
      { title: "D", description: "", worker: { existing: 9 } },
      { title: "E", description: "" },
      // The same new worker described twice in one call is one worker.
      { title: "F", description: "", worker: { new: "checkout flow" } },
    ]);
    const workers = store.getProject(dir)!.workers;
    assert.deepEqual(
      workers.map((w) => [w.n, w.description]),
      [[1, "Checkout flow"], [2, "D"], [3, "E"]]
    );
    assert.equal(b.workerId, workers[0].id);
    assert.equal(c.workerId, workers[0].id);
    assert.equal(d.workerId, workers[1].id);
    assert.equal(e.workerId, workers[2].id);
    assert.equal(f.workerId, workers[0].id);
    assert.deepEqual(events[0], { type: "workers", workers });

    // Its agent reaching init moves the worker's conversation on — and the feed hears.
    store.setWorkerSession(dir, workers[0].id, "claude:s1");
    assert.equal(store.getProject(dir)!.workers[0].sessionId, "claude:s1");
    assert.equal(events.at(-1)!.type, "workers");
    // A ticket on a worker the planner did not create again keeps the list as is.
    const n = events.length;
    store.addTickets(dir, [{ title: "G", description: "", worker: { existing: 2 } }]);
    assert.equal(events[n].type, "tickets");
    assert.equal(store.getProject(dir)!.workers.length, 3);
    // Deleting a ticket leaves its worker.
    store.removeTickets(dir, [b.id, c.id]);
    assert.equal(store.getProject(dir)!.workers.length, 3);
  } finally {
    unsubscribe();
    await store.forget(dir);
  }
});

test("a project from before workers reads with an empty list", async () => {
  const dir = path.join(SCRATCH, "migrate");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".autoproject"), { recursive: true });
  const old: Partial<Project> = defaultProject("Old", dir);
  delete old.workers;
  fs.writeFileSync(path.join(dir, ".autoproject", "project.json"), JSON.stringify(old));
  assert.deepEqual(readProject(dir)!.workers, []);
});
