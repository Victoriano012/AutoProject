import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdingForRestart, restartStatus, suspended, updateAndRestart } from "../lib/server/restart.ts";
import { registry, ticketKey } from "../lib/server/run-registry.ts";
import { runLimiter } from "../lib/server/run-limiter.ts";
import { autoRun, ensureLoaded, ownsTicket, runTicket, sendFeedback, stopProject } from "../lib/server/runs.ts";
import { sendToAgent } from "../lib/server/project-agent.ts";
import * as store from "../lib/server/project-store.ts";
import { readProject, writeProject } from "../lib/projects-fs.ts";
import { defaultProject, type Ticket } from "../lib/types.ts";

const ticket = (id: string, status: Ticket["status"], files: string[]): Ticket => ({ id, title: id, description: "", files, status, log: [] });
const until = async (ok: () => boolean) => {
  for (const end = Date.now() + 5000; !ok(); await new Promise((r) => setTimeout(r, 5))) assert.ok(Date.now() < end, "timed out");
};
/** A ticket run at work, as the registry knows it, that winds down only once
 * `finish` is called: the restart waits for it before swapping. */
function working(dir: string, id: string) {
  const key = ticketKey(dir, id);
  const controller = new AbortController();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  registry.controllers.set(key, controller);
  registry.claims.set(key, { dir, ticket: ticket(id, "running", []), done, release });
  return {
    signal: controller.signal,
    finish: () => { registry.controllers.delete(key); registry.claims.delete(key); release(); },
  };
}

test("a failed build keeps the server serving", async () => {
  let swapped = false;
  await updateAndRestart({ build: async () => "Type error in app/page.tsx", swap: () => { swapped = true; } });
  assert.deepEqual(restartStatus(), { phase: "failed" });
  assert.equal(swapped, false);
  assert.equal(holdingForRestart(), false);
});

test("once built, it swaps at once: work is cut short, and nothing new starts until the swap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoproject-restart-"));
  writeProject(dir, { ...defaultProject("Restart", dir), tickets: [
    ticket("busy", "running", ["a.ts"]), ticket("next", "todo", ["b.ts"]), ticket("done", "review", ["c.ts"]),
  ] });
  // Were the hold to fail, a started run would park on this slot, not reach a provider.
  process.env.AUTOPROJECT_MAX_RUNS = "1";
  const releaseSlot = await runLimiter.acquire("claude", new AbortController().signal);
  const busy = working(dir, "busy");
  let swappedTo: string | undefined;
  try {
    const restart = updateAndRestart({ build: async () => null, swap: (distDir) => { swappedTo = distDir; } });
    await until(() => restartStatus().phase === "restarting");
    // Not waited on: cut short, for the next server to carry on.
    assert.equal(suspended(busy.signal), true);
    ensureLoaded(dir); // loading starts queued cards, so only once held

    await runTicket(dir, "next");
    assert.equal(registry.controllers.has(ticketKey(dir, "next")), false);
    assert.equal(store.getProject(dir)!.tickets[1].log.at(-1)?.text, "Waiting for AutoProject to restart.");
    const request = sendToAgent(dir, "panel", "Add a cart");
    await sendFeedback(dir, "done", "Make it blue");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(registry.agents.has(dir), false);
    assert.equal(swappedTo, undefined, "the swap waits for the cut-short run to wind down");

    // What was held is on disk for the next server: the request queued, the feedback pending.
    await store.flush(dir);
    const saved = readProject(dir)!;
    assert.deepEqual(saved.agentRequests!.map((r) => [r.id, r.state]), [[request!.id, "queued"]]);
    assert.deepEqual(saved.pendingFeedback, { done: "Make it blue" });

    busy.finish();
    await restart;
    assert.equal(swappedTo, ".next-live/a");
    assert.equal(restartStatus().phase, "restarting");
  } finally {
    busy.finish();
    releaseSlot();
    delete process.env.AUTOPROJECT_MAX_RUNS;
    registry.removing.add(dir);
    registry.requests.delete(dir);
    registry.pendingFeedback.delete(ticketKey(dir, "done"));
    await store.forget(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the next server starts what was pressed or due during the swap, but not a paused card", async () => {
  // Each test plays a server; the one before this ended in its restart.
  const server = (globalThis as unknown as { __autoprojectRestart: { phase: string } }).__autoprojectRestart;
  server.phase = "idle";
  const dir = mkdtempSync(join(tmpdir(), "autoproject-restart-"));
  writeProject(dir, { ...defaultProject("Restart", dir), tickets: [
    ticket("busy", "running", ["a.ts"]),
    ticket("due", "todo", ["a.ts"]), // the scheduler's once "busy" frees a.ts
    ticket("pressed", "error", ["b.ts"]), // its Retry is pressed during the wait
    { ...ticket("paused", "todo", ["c.ts"]), paused: true },
  ] });
  process.env.AUTOPROJECT_MAX_RUNS = "1";
  const releaseSlot = await runLimiter.acquire("claude", new AbortController().signal);
  const busy = working(dir, "busy");
  ensureLoaded(dir);
  try {
    const restart = updateAndRestart({ build: async () => null, swap: () => {} });
    await until(() => restartStatus().phase === "restarting");
    await runTicket(dir, "pressed");
    // "busy" winds down as one that finished; the end of its run asks the
    // scheduler, which holds.
    store.updateTicket(dir, "busy", (t) => ({ ...t, status: "review" }));
    busy.finish();
    autoRun(dir);
    await restart;
    assert.equal(ownsTicket(dir, "due") || ownsTicket(dir, "pressed"), false);

    // The next server reads the board back from disk.
    await store.forget(dir);
    registry.requests.delete(dir);
    server.phase = "idle";
    ensureLoaded(dir);
    await until(() => ownsTicket(dir, "due") && ownsTicket(dir, "pressed"));
    assert.equal(ownsTicket(dir, "paused"), false);
  } finally {
    stopProject(dir, true);
    await registry.loopTasks.get(dir);
    releaseSlot();
    delete process.env.AUTOPROJECT_MAX_RUNS;
    registry.removing.add(dir);
    registry.requests.delete(dir);
    await store.forget(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("shutting down ends every open live feed, so the old server can exit and its tabs reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoproject-feed-"));
  writeProject(dir, defaultProject("Feed", dir));
  const { GET } = await import("../app/api/runs/stream/route.ts");
  try {
    const res = await GET(new Request(`http://localhost/api/runs/stream?dir=${encodeURIComponent(dir)}`));
    // Next waits on open connections before it exits; an ended feed must not leave one.
    assert.equal(res.headers.get("connection"), "close");
    const feed = res.body!.getReader();
    assert.match(new TextDecoder().decode((await feed.read()).value), /"type":"snapshot"/);
    process.emit("SIGTERM");
    let read = await feed.read();
    while (!read.done) read = await feed.read();
  } finally {
    await store.forget(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});
