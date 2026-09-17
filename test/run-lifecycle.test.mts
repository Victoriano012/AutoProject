import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLimiter } from "../lib/server/run-limiter.ts";
import { registry, ticketKey } from "../lib/server/run-registry.ts";
import { claimedTickets, ensureLoaded, removeTickets, runTicket, sendFeedback, stopProject } from "../lib/server/runs.ts";
import { finishProjectRemoval, prepareProjectRemoval } from "../lib/server/project-lifecycle.ts";
import { createBoardIndex } from "../lib/board-index.ts";
import * as store from "../lib/server/project-store.ts";
import { writeProject } from "../lib/projects-fs.ts";
import { defaultProject, type Ticket } from "../lib/types.ts";
import { runRequestSchema, agentRequestSchema } from "../lib/server/command-schemas.ts";

const ticket = (id: string, status: Ticket["status"] = "todo"): Ticket => ({
  id, title: id, description: "", files: ["src/shared.ts"], status, log: [],
});
async function fixture(work: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "autoproject-runs-"));
  writeProject(dir, { ...defaultProject("Lifecycle", dir), tickets: [ticket("owner", "running"), ticket("next")] });
  store.getProject(dir);
  try { await work(dir); }
  finally {
    registry.removing.add(dir);
    for (const [key, claim] of registry.claims) if (claim.dir === dir) { claim.release(); registry.claims.delete(key); }
    for (const map of [registry.controllers, registry.pendingFeedback, registry.notes]) {
      for (const key of map.keys()) if (key.startsWith(dir + "\u0000")) map.delete(key);
    }
    registry.agents.delete(dir);
    registry.requests.delete(dir);
    await registry.agentTasks.get(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
    rmSync(dir, { force: true, recursive: true });
  }
}
function claim(dir: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  registry.claims.set(ticketKey(dir, "owner"), { dir, ticket: ticket("owner", "running"), done, release });
  const controller = new AbortController();
  registry.controllers.set(ticketKey(dir, "owner"), controller);
  return { done, release, controller };
}

test("capacity limits span providers, preserve FIFO, and discard cancelled waiters", async () => {
  const limiter = new RunLimiter(() => 2, () => 1);
  const signal = new AbortController().signal;
  const first = await limiter.acquire("codex", signal);
  let secondStarted = false;
  const second = limiter.acquire("codex", signal).then((release) => { secondStarted = true; return release; });
  const other = await limiter.acquire("claude", signal);
  await Promise.resolve();
  assert.equal(secondStarted, false);
  const cancelled = new AbortController();
  const waiting = limiter.acquire("gemini", cancelled.signal);
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  other();
  assert.equal(secondStarted, false); // per-provider limit still held
  first();
  const releaseSecond = await second;
  releaseSecond(); releaseSecond(); // cannot over-release
  const third = await limiter.acquire("codex", signal);
  third();
});

test("deleting or completing a card keeps file ownership until the process exits", async () => {
  await fixture(async (dir) => {
    const live = claim(dir);
    store.updateTicket(dir, "owner", (t) => ({ ...t, status: "done", files: ["other.ts"] }));
    assert.equal(createBoardIndex(claimedTickets(dir)).fileHolders("next")[0]?.by.id, "owner");
    removeTickets(dir, ["owner"]);
    assert.equal(live.controller.signal.aborted, true);
    assert.equal(createBoardIndex(claimedTickets(dir)).fileHolders("next")[0]?.by.id, "owner");
    await runTicket(dir, "next"); // must never reach a real provider
    assert.equal(store.getProject(dir)!.tickets[0].status, "todo");
    registry.claims.delete(ticketKey(dir, "owner")); live.release();
    assert.equal(createBoardIndex(claimedTickets(dir)).fileHolders("next").length, 0);
  });
});

test("duplicate starts are ignored and queued feedback survives a store restart", async () => {
  await fixture(async (dir) => {
    claim(dir);
    await runTicket(dir, "owner");
    assert.equal(registry.controllers.size, 1);
    await sendFeedback(dir, "next", "Keep the new API compatible");
    await store.flush(dir);
    registry.pendingFeedback.clear(); registry.requests.delete(dir);
    await store.forget(dir);
    ensureLoaded(dir);
    assert.equal(registry.pendingFeedback.get(ticketKey(dir, "next")), "Keep the new API compatible");
  });
});

test("project removal cancels every queue and waits for workspace owners", async () => {
  await fixture(async (dir) => {
    const live = claim(dir);
    const agent = new AbortController();
    registry.agents.set(dir, agent);
    registry.requests.set(dir, [{ id: "queued", state: "queued", mode: "act", text: "Later" }]);
    await sendFeedback(dir, "next", "Queued correction");
    let finished = false;
    const stopping = prepareProjectRemoval(dir).then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(agent.signal.aborted, true);
    assert.equal(live.controller.signal.aborted, true);
    assert.deepEqual(registry.requests.get(dir), []);
    assert.deepEqual(store.getProject(dir)!.pendingFeedback, {});
    await runTicket(dir, "next");
    assert.equal(store.getProject(dir)!.tickets.find((t) => t.id === "next")!.status, "todo");
    live.release(); await stopping;
    assert.equal(finished, true);
    assert.equal(registry.removing.has(dir), true);
    assert.equal(ensureLoaded(dir), null);
    await assert.rejects(prepareProjectRemoval(dir), /already being removed/);
  });
});

test("Stop Project stops the project agent as well as ticket agents", async () => {
  await fixture(async (dir) => {
    const live = claim(dir);
    const agent = new AbortController(); registry.agents.set(dir, agent);
    stopProject(dir, true);
    assert.equal(agent.signal.aborted, true);
    assert.equal(live.controller.signal.aborted, true);
    assert.equal(store.getProject(dir)!.tickets.find((ticket) => ticket.id === "owner")!.paused, true);
  });
});

test("run and project-agent commands reject malformed action-specific input", () => {
  assert.equal(runRequestSchema.safeParse({ dir: "/project", action: "runTicket" }).success, false);
  assert.equal(runRequestSchema.safeParse({ dir: "/project", action: "sendFeedback", ticketId: "a", message: " " }).success, false);
  assert.equal(agentRequestSchema.safeParse({ dir: "/project", action: "send", message: "Hi", mode: "invalid" }).success, false);
  assert.equal(runRequestSchema.safeParse({ dir: "/project", action: "stopProject" }).success, true);
});

test("run API acknowledges before a capacity-waiting agent finishes", async () => {
  const { POST } = await import("../app/api/runs/route.ts");
  const { runLimiter } = await import("../lib/server/run-limiter.ts");
  const previous = process.env.AUTOPROJECT_MAX_RUNS;
  process.env.AUTOPROJECT_MAX_RUNS = "1";
  const release = await runLimiter.acquire("claude", new AbortController().signal);
  try {
    await fixture(async (dir) => {
      store.setProject(dir, { ...store.getProject(dir)!, tickets: [ticket("next")] });
      const response = await POST(new Request("http://localhost/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir, action: "runTicket", ticketId: "next" }),
      }));
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.dir, dir);
      assert.deepEqual(body.runs.tickets, ["next"]);
      const run = registry.claims.get(ticketKey(dir, "next"))!;
      assert.ok(run);
      stopProject(dir, true);
      await run.done;
      assert.equal(store.getProject(dir)!.tickets[0].paused, true);
    });
  } finally {
    release();
    if (previous === undefined) delete process.env.AUTOPROJECT_MAX_RUNS;
    else process.env.AUTOPROJECT_MAX_RUNS = previous;
  }
});

test("persisted project requests are restored in order and interrupted requests require retry", async () => {
  const { sendToAgent } = await import("../lib/server/project-agent.ts");
  await fixture(async (dir) => {
    registry.agents.set(dir, new AbortController()); // no real inference
    sendToAgent(dir, "panel", "First queued request");
    sendToAgent(dir, "act", "Second queued request");
    const project = store.getProject(dir)!;
    store.setProject(dir, { ...project, agentRequests: [
      { id: "interrupted", state: "running", mode: "panel", text: "Already started" },
      ...project.agentRequests!,
    ] });
    await store.forget(dir);
    registry.requests.delete(dir);
    ensureLoaded(dir);
    assert.deepEqual(registry.requests.get(dir)!.map((r) => [r.text, r.state]), [
      ["Already started", "error"], ["First queued request", "queued"], ["Second queued request", "queued"],
    ]);
    // Let queue restoration observe the fake running agent before cleanup.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
