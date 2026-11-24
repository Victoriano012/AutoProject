import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdingForRestart, restartStatus, updateAndRestart } from "../lib/server/restart.ts";
import { registry, ticketKey } from "../lib/server/run-registry.ts";
import { runLimiter } from "../lib/server/run-limiter.ts";
import { ensureLoaded, runTicket, sendFeedback } from "../lib/server/runs.ts";
import { sendToAgent } from "../lib/server/project-agent.ts";
import * as store from "../lib/server/project-store.ts";
import { readProject, writeProject } from "../lib/projects-fs.ts";
import { defaultProject, type Ticket } from "../lib/types.ts";

const ticket = (id: string, status: Ticket["status"], files: string[]): Ticket => ({ id, title: id, description: "", files, status, log: [] });
const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };

test("a failed build keeps the server serving and reports why", async () => {
  let swapped = false;
  await updateAndRestart({ build: async () => "Type error in app/page.tsx", swap: () => { swapped = true; } });
  assert.deepEqual(restartStatus(), { phase: "failed", agents: 0, error: "Type error in app/page.tsx" });
  assert.equal(swapped, false);
  assert.equal(holdingForRestart(), false);
});

test("once built, nothing new starts; the swap waits for every agent at work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autoproject-restart-"));
  writeProject(dir, { ...defaultProject("Restart", dir), tickets: [
    ticket("busy", "running", ["a.ts"]), ticket("next", "todo", ["b.ts"]), ticket("done", "review", ["c.ts"]),
  ] });
  ensureLoaded(dir);
  // Were the hold to fail, a started run would park on this slot, not reach a provider.
  process.env.AUTOPROJECT_MAX_RUNS = "1";
  const releaseSlot = await runLimiter.acquire("claude", new AbortController().signal);
  const working = new AbortController();
  registry.controllers.set(ticketKey(dir, "busy"), working);
  let swappedTo: string | undefined;
  try {
    const restart = updateAndRestart({ build: async () => null, swap: (distDir) => { swappedTo = distDir; } });
    await until(() => restartStatus().phase === "waiting");
    assert.equal(restartStatus().agents, 1);

    await runTicket(dir, "next");
    assert.equal(registry.controllers.has(ticketKey(dir, "next")), false);
    assert.equal(store.getProject(dir)!.tickets[1].log.at(-1)?.text, "Waiting for AutoProject to restart.");
    const request = sendToAgent(dir, "panel", "Add a cart");
    await sendFeedback(dir, "done", "Make it blue");
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(registry.agents.has(dir), false);
    assert.equal(swappedTo, undefined);

    // What was held is on disk for the next server: the request queued, the feedback pending.
    await store.flush(dir);
    const saved = readProject(dir)!;
    assert.deepEqual(saved.agentRequests!.map((r) => [r.id, r.state]), [[request!.id, "queued"]]);
    assert.deepEqual(saved.pendingFeedback, { done: "Make it blue" });

    registry.controllers.delete(ticketKey(dir, "busy"));
    await restart;
    assert.equal(swappedTo, ".next-live/a");
    assert.equal(restartStatus().phase, "restarting");
  } finally {
    registry.controllers.delete(ticketKey(dir, "busy"));
    releaseSlot();
    delete process.env.AUTOPROJECT_MAX_RUNS;
    registry.removing.add(dir);
    registry.requests.delete(dir);
    registry.pendingFeedback.delete(ticketKey(dir, "done"));
    await store.forget(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});
