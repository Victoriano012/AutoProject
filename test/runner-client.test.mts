import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { defaultProject } from "../lib/types.ts";
import type { RunStateSnapshot } from "../lib/runner.ts";
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
} });
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const { useStore } = await import("../lib/store.ts");
const { applyRunState, isTicketRunLive, runTicket, sendToAgent, setProjectFlush, subscribeRuns } = await import("../lib/runner.ts");
after(() => { Reflect.deleteProperty(globalThis, "localStorage"); Reflect.deleteProperty(globalThis, "window"); });
const actualFetch = globalThis.fetch;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => resolve = r); return { promise, resolve }; };
const runs = (tickets: string[] = []): RunStateSnapshot => ({ loops: [], active: [], tickets, agent: { busy: false, mode: null, requests: [], subagents: [] } });
const open = (projectId: string) => useStore.setState({ projectId, projectLoaded: true, project: defaultProject(projectId) });
afterEach(() => { globalThis.fetch = actualFetch; setProjectFlush(async () => {}); applyRunState(runs()); });

test("a delayed run acknowledgement from A cannot replace B's run state", async () => {
  open("A"); setProjectFlush(async () => {});
  const response = deferred<Response>();
  const requested = deferred<void>();
  globalThis.fetch = async () => { requested.resolve(); return response.promise; };
  const running = runTicket("a");
  await requested.promise;
  open("B"); applyRunState(runs(["b"]));
  response.resolve(Response.json({ dir: "A", runs: runs(["a"]) }));
  await running;
  assert.equal(isTicketRunLive("b"), true);
  assert.equal(isTicketRunLive("a"), false);
});

test("a message submitted in A stays in A when navigation occurs during its save", async () => {
  open("A");
  const saved = deferred<void>();
  setProjectFlush(() => saved.promise);
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ ok: true }); };
  const sending = sendToAgent("act", "A's instructions");
  open("B");
  saved.resolve();
  assert.equal(await sending, true);
  assert.deepEqual(sent, { dir: "A", action: "send", mode: "act", message: "A's instructions" });
});

test("a delayed acknowledgement cannot replace newer streamed state in the same project", async () => {
  open("A"); setProjectFlush(async () => {});
  const response = deferred<Response>();
  const requested = deferred<void>();
  globalThis.fetch = async () => { requested.resolve(); return response.promise; };
  const running = runTicket("a");
  await requested.promise;
  applyRunState(runs()); // the agent already finished before its HTTP response arrives
  response.resolve(Response.json({ dir: "A", runs: runs(["a"]) }));
  await running;
  assert.equal(isTicketRunLive("a"), false);
});

test("failed flushes prevent both ticket and project-agent commands from being sent", async () => {
  open("A"); setProjectFlush(async () => { throw new Error("save failed"); });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(runTicket("a"), /save failed/);
  assert.equal(await sendToAgent("act", "Do work"), false);
  assert.equal(calls, 0);
});


test("runner subscriptions, state and flush callbacks survive a module replacement", async () => {
  open("A");
  let notifications = 0, flushes = 0;
  const unsubscribe = subscribeRuns(() => { notifications++; });
  setProjectFlush(async () => { flushes++; });
  applyRunState(runs(["already-running"]));
  const refreshed = await import(new URL("../lib/runner.ts?client-hmr", import.meta.url).href) as typeof import("../lib/runner.ts");
  assert.equal(refreshed.isTicketRunLive("already-running"), true);
  refreshed.applyRunState(runs());
  assert.equal(notifications, 2);
  globalThis.fetch = async () => Response.json({ dir: "A", runs: runs(["new-run"]) });
  await refreshed.runTicket("new-run");
  assert.equal(flushes, 1);
  assert.equal(isTicketRunLive("new-run"), true);
  unsubscribe();
});

test("a message waiting through a server restart stays on screen until the next server's snapshot", async (t) => {
  const feeds: FakeFeed[] = [];
  class FakeFeed {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    constructor() { feeds.push(this); }
    close() {}
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeFeed });
  t.after(() => { Reflect.deleteProperty(globalThis, "EventSource"); useStore.setState({ projectId: null, projectLoaded: false }); });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { agentRequests } = await import("../lib/runner.ts");
  const { openProject } = await import("../lib/sync.ts");
  const project = defaultProject("A");
  globalThis.fetch = async () => Response.json({ data: project });
  await openProject("A");
  const waiting = { id: "r1", mode: "act", text: "Sent while the update waited", state: "queued" } as const;
  const snapshot = (requests: RunStateSnapshot["agent"]["requests"]) =>
    ({ data: JSON.stringify({ type: "snapshot", project, runs: { ...runs(), agent: { ...runs().agent, requests } } }) });
  feeds[0].onmessage!(snapshot([waiting]));
  assert.deepEqual(agentRequests(), [waiting]);
  feeds[0].onerror!(); // the old server ended its feed on the way out
  t.mock.timers.tick(2000);
  assert.equal(feeds.length, 2, "the tab reconnects on its own");
  assert.deepEqual(agentRequests(), [waiting]);
  feeds[1].onmessage!(snapshot([{ ...waiting, state: "running", heard: true }]));
  assert.equal(agentRequests()[0].heard, true);
});
