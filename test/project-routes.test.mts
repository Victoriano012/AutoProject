import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { defaultProject, newTicket } from "../lib/types.ts";
import { applyProjectPatch, EditConflict, projectChanges } from "../lib/project-edits.ts";

// These handlers must never discover or rewrite the person's actual registry.
const suite = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-routes-")));
process.env.AUTOPROJECT_HOME = suite;
process.env.AUTOPROJECT_REGISTRY = path.join(suite, "imports.json");
const { GET, PATCH, PUT, DELETE } = await import("../app/api/projects/[id]/route.ts");
const { GET: historyGET } = await import("../app/api/projects/[id]/history/route.ts");
const { readProject, writeProject } = await import("../lib/projects-fs.ts");
const store = await import("../lib/server/project-store.ts");
const { registry, ticketKey } = await import("../lib/server/run-registry.ts");
after(() => fs.rmSync(suite, { recursive: true, force: true }));
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown, query = "") => new Request(`http://localhost/api/projects/test${query}`, {
  method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});
async function fixture(run: (dir: string) => Promise<void>, name = "project-") {
  const dir = fs.mkdtempSync(path.join(suite, name));
  writeProject(dir, { ...defaultProject("Original", dir), tickets: [newTicket({ id: "a", paused: true, sessionId: "keep-session" })] });
  try { await run(dir); }
  finally { await store.forget(dir); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("PATCH saves field changes durably, merges unrelated stale edits, and rejects same-field conflicts", async () => {
  await fixture(async (dir) => {
    const original = (await (await GET(request("GET"), context(dir))).json()).data;
    store.appendLog(dir, "a", { kind: "text", text: "server output", ts: 1 });
    const changed = { ...original, description: "First tab" };
    const first = await PATCH(request("PATCH", projectChanges(original, changed)), context(dir));
    assert.equal(first.status, 200);
    assert.equal(readProject(dir)!.description, "First tab");
    assert.equal(readProject(dir)!.tickets[0].sessionId, "keep-session");
    assert.equal(readProject(dir)!.tickets[0].log[0].text, "server output");
    const other = await PATCH(request("PATCH", projectChanges(original, { ...original, name: "Other tab" })), context(dir));
    assert.equal(other.status, 200);
    assert.equal(readProject(dir)!.description, "First tab");
    assert.equal(readProject(dir)!.name, "Other tab");
    const conflict = await PATCH(request("PATCH", projectChanges(original, { ...original, description: "Stale overwrite" })), context(dir));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).data.description, "First tab");
    assert.equal(readProject(dir)!.description, "First tab");
  });
});

test("project routes reject unknown fields, malformed JSON and legacy whole-document writes", async () => {
  await fixture(async (dir) => {
    const attempts = [
      { revision: 0, changes: [{ scope: "ticket", id: "a", field: "sessionId", before: "keep-session", value: "overwrite" }], edits: [] },
      { revision: 0, changes: [{ scope: "project", field: "name", before: "Original", value: null }], edits: [] },
      { revision: -1, changes: [], edits: [] },
    ];
    for (const body of attempts) assert.equal((await PATCH(request("PATCH", body), context(dir))).status, 400);
    assert.equal((await PATCH(new Request("http://localhost/", { method: "PATCH", body: "{" }), context(dir))).status, 400);
    assert.equal((await PUT()).status, 409);
    assert.equal(readProject(dir)!.name, "Original");
    assert.equal((await DELETE(request("DELETE", undefined, "?mode=invalid"), context(dir))).status, 400);
  });
});

test("erase endpoint refuses unmanaged folders and waits for active workspace claims before deleting", async () => {
  const unmanaged = fs.mkdtempSync(path.join(suite, "unmanaged-"));
  fs.writeFileSync(path.join(unmanaged, "keep.txt"), "keep");
  assert.equal((await DELETE(request("DELETE", undefined, "?mode=erase"), context(unmanaged))).status, 400);
  assert.equal(fs.readFileSync(path.join(unmanaged, "keep.txt"), "utf8"), "keep");
  await fixture(async (dir) => {
    const key = ticketKey(dir, "a");
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    registry.claims.set(key, { dir, ticket: { ...store.getProject(dir)!.tickets[0], status: "running" }, done, release });
    registry.controllers.set(key, controller);
    try {
      let completed = false;
      const deleting = DELETE(request("DELETE", undefined, "?mode=erase"), context(dir)).then((response) => { completed = true; return response; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(controller.signal.aborted, true);
      assert.equal(completed, false);
      assert.equal(fs.existsSync(dir), true);
      release();
      assert.equal((await deleting).status, 200);
      assert.equal(fs.existsSync(dir), false);
      assert.equal(registry.removing.has(dir), false);
    } finally { release(); registry.claims.delete(key); registry.controllers.delete(key); }
  });
});

test("history route flushes pending entries, pages chronologically, and accepts literal percent paths", async () => {
  await fixture(async (dir) => {
    for (let i = 0; i < 3; i++) store.appendLog(dir, "a", { kind: "text", text: String(i), ts: i });
    const first = await historyGET(request("GET", undefined, "?ticketId=a&limit=2"), context(dir));
    assert.equal(first.status, 200);
    const page = await first.json();
    assert.deepEqual(page.entries.map((entry: { text: string }) => entry.text), ["0", "1"]);
    assert.equal(typeof page.nextCursor, "number");
    const next = await historyGET(request("GET", undefined, `?ticketId=a&limit=2&cursor=${page.nextCursor}`), context(dir));
    assert.deepEqual((await next.json()).entries.map((entry: { text: string }) => entry.text), ["2"]);
    assert.equal((await historyGET(request("GET", undefined, "?cursor=-1"), context(dir))).status, 400);
  }, "100%-project-");
});


test("reopen patches reject active owners and idempotent retries keep their timestamp", () => {
  const project = { ...defaultProject("Reopen"), tickets: [newTicket({ id: "a", status: "done", statusChangedAt: 1 })] };
  const changed = { ...project, tickets: project.tickets.map((ticket) => ({ ...ticket, status: "todo" as const })) };
  const patch = projectChanges(project, changed);
  assert.throws(() => applyProjectPatch(project, patch, () => true), EditConflict);
  const saved = applyProjectPatch(project, patch);
  assert.equal(saved.tickets[0].status, "todo");
  assert.ok(saved.tickets[0].statusChangedAt! > 1);
  assert.deepEqual(applyProjectPatch(saved, patch), saved);
});
