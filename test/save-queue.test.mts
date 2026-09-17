import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSaveQueue, SaveConflict } from "../lib/save-queue.ts";
import { applyProjectPatch, EditConflict, projectChanges } from "../lib/project-edits.ts";
import { reduceProjectEvent } from "../lib/project-events.ts";
import { defaultProject, type Project } from "../lib/types.ts";
const initial = (): Project => ({ ...defaultProject("Original"), tickets: [{ id: "t", title: "Ticket", description: "", status: "review", log: [], sessionId: "old" }] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => resolve = r); return { resolve, promise }; };

test("field patches preserve unrelated edits and reject same-field collisions", () => {
  const base = initial();
  const patch = projectChanges(base, { ...base, name: "Mine" });
  const remote = { ...base, description: "Theirs" };
  assert.equal(applyProjectPatch(remote, patch).description, "Theirs");
  assert.throws(() => applyProjectPatch({ ...remote, name: "Theirs" }, patch), EditConflict);
});

test("flush waits for acknowledgement and serializes edits made in flight", async () => {
  const base = initial();
  const first = deferred<Project>();
  let server = base;
  let calls = 0;
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => {
    calls++; server = applyProjectPatch(server, patch);
    if (calls === 1) { await first.promise; }
    return server;
  } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "First" });
  const flushing = queue.flush("a");
  assert.equal(queue.state("a").status, "saving");
  queue.edit("a", { ...queue.current("a")!, name: "Second" });
  assert.equal(calls, 1);
  first.resolve(server); await flushing;
  assert.equal(calls, 2); assert.equal(server.name, "Second");
  assert.equal(queue.state("a").status, "saved");
});

test("failed saves keep edits and retry; separate project queues do not consume them", async () => {
  const base = initial(); let fail = true;
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => { if (fail) throw new Error("offline"); return applyProjectPatch(base, patch); } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Kept" }); queue.seed("b", base);
  await assert.rejects(queue.flush("a"), /offline/);
  assert.equal(queue.current("a")!.name, "Kept"); assert.equal(queue.current("b")!.name, "Original");
  fail = false; await queue.flush("a", true); assert.equal(queue.state("a").status, "saved");
});

test("live updates cannot absorb local edits or erase their conflict comparison", async () => {
  const base = initial(); const remote = { ...base, name: "Other tab", notes: ["remote note"] };
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => {
    try { return applyProjectPatch(remote, patch); } catch (error) { throw new SaveConflict((error as Error).message, remote); }
  } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" }); queue.receive("a", remote);
  assert.equal(queue.current("a")!.notes[0], "remote note");
  await assert.rejects(queue.flush("a"), /changed elsewhere/);
  assert.equal(queue.current("a")!.name, "Mine");
  await queue.flush("a", true); assert.equal(queue.state("a").status, "saved");
});

test("server acknowledgements apply explicit reopen without an incoming stream event", async () => {
  const base = initial();
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => applyProjectPatch(base, patch) });
  queue.seed("a", base); queue.edit("a", { ...base, tickets: base.tickets.map((t) => ({ ...t, status: "todo" })) });
  await queue.flush("a"); assert.equal(queue.current("a")!.tickets[0].status, "todo");
});

test("wire events clear optional fields and bound live transcript memory", () => {
  let project = reduceProjectEvent(initial(), { type: "ticket", id: "t", patch: {}, unset: ["sessionId"] });
  assert.equal(project.tickets[0].sessionId, undefined);
  project = reduceProjectEvent({ ...project, agentSessionId: "old" }, { type: "agent-session", sessionId: null });
  assert.equal(project.agentSessionId, undefined);
  project = reduceProjectEvent(project, { type: "log", id: "t", entries: Array.from({ length: 1100 }, (_, ts) => ({ ts, kind: "text" as const, text: "line" })) });
  assert.equal(project.tickets[0].log.length, 1000);
});

test("recovered reopen intent retains its original status comparison and reaches the server", async () => {
  const base = initial();
  const draft = { ...base, tickets: base.tickets.map((t) => ({ ...t, status: "todo" as const })) };
  let calls = 0;
  const queue = new ProjectSaveQueue({ send: async (_id, patch) => { calls++; return applyProjectPatch(base, patch); } });
  queue.seed("a", base, projectChanges(base, draft));
  assert.deepEqual(queue.pending("a")!.edits, [{ id: "t", before: "review", status: "todo" }]);
  await queue.flush("a");
  assert.equal(calls, 1);
  assert.equal(queue.current("a")!.tickets[0].status, "todo");
});

test("an older HTTP acknowledgement cannot erase a newer streamed user edit", async () => {
  const base = initial();
  const ack = deferred<Project>();
  let calls = 0;
  const queue = new ProjectSaveQueue({ delay: 100000, send: async () => { calls++; return ack.promise; } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" });
  const saving = queue.flush("a");
  queue.receive("a", { ...base, name: "Other tab after my save", revision: 2 });
  ack.resolve({ ...base, name: "Mine", revision: 1 });
  await saving;
  assert.equal(queue.current("a")!.name, "Other tab after my save");
  assert.equal(queue.current("a")!.revision, 2);
  assert.equal(queue.state("a").status, "saved");
  assert.equal(calls, 1);
});

test("streamed user fields during a flight are not manufactured into another local save", async () => {
  const base = initial();
  const ack = deferred<Project>();
  let calls = 0;
  const queue = new ProjectSaveQueue({ delay: 100000, send: async () => { calls++; return ack.promise; } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" });
  const saving = queue.flush("a");
  queue.receive("a", { ...base, name: "Mine", description: "Another tab", revision: 2 });
  ack.resolve({ ...base, name: "Mine", revision: 1 });
  await saving;
  assert.equal(calls, 1);
  assert.equal(queue.current("a")!.description, "Another tab");
});

test("edits typed during a flight keep their comparison against concurrent changes", async () => {
  const base = initial();
  const ack = deferred<Project>();
  let calls = 0;
  const latest = { ...base, name: "Other tab", revision: 2 };
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => {
    if (++calls === 1) return ack.promise;
    try { return applyProjectPatch(latest, patch); }
    catch (error) { throw new SaveConflict((error as Error).message, latest); }
  } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" });
  const saving = queue.flush("a");
  queue.edit("a", { ...queue.current("a")!, name: "Mine again" });
  queue.receive("a", latest);
  ack.resolve({ ...base, name: "Mine", revision: 1 });
  await assert.rejects(saving, /changed elsewhere/);
  assert.equal(queue.current("a")!.name, "Mine again");
  assert.equal(queue.state("a").status, "error");
});

test("conflict errors from another module instance still support explicit retry", async () => {
  const base = initial();
  const remote = { ...base, name: "Other" };
  let fail = true;
  const queue = new ProjectSaveQueue({ delay: 100000, send: async (_id, patch) => {
    if (fail) throw Object.assign(new Error("conflict"), { name: "SaveConflict", remote });
    return applyProjectPatch(remote, patch);
  } });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" });
  await assert.rejects(queue.flush("a"), /conflict/);
  fail = false;
  await queue.flush("a", true);
  assert.equal(queue.current("a")!.name, "Mine");
});

test("incremental events after a save snapshot retain both new metadata and same-revision notes", async () => {
  const base = initial();
  const ack = deferred<Project>();
  const queue = new ProjectSaveQueue({ delay: 100000, send: async () => ack.promise });
  queue.seed("a", base); queue.edit("a", { ...base, name: "Mine" });
  const saving = queue.flush("a");
  const accepted = { ...base, name: "Mine", revision: 1 };
  queue.receive("a", accepted);
  queue.receive("a", reduceProjectEvent(queue.remote("a")!, { type: "notes", notes: ["Agent added this after the save"] }));
  queue.receive("a", reduceProjectEvent(queue.remote("a")!, { type: "log", id: "t", entries: [{ kind: "text", text: "new output", ts: 1 }] }));
  ack.resolve(accepted);
  await saving;
  assert.deepEqual(queue.current("a")!.notes, ["Agent added this after the save"]);
  assert.equal(queue.current("a")!.name, "Mine");
  assert.equal(queue.current("a")!.tickets[0].log[0].text, "new output");
});
