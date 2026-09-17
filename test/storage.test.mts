import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertManagedProject, readProject, writeProject } from "../lib/projects-fs.ts";
import { defaultProject, newTicket } from "../lib/types.ts";
import { CHAT_CAP, TICKET_LOG_CAP, type ProjectEvent } from "../lib/project-events.ts";
import * as store from "../lib/server/project-store.ts";
import { readProjectHistory } from "../lib/server/project-history.ts";

function scratch(name: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `autoproject-${name}-`)));
  writeProject(dir, { ...defaultProject(name, dir), tickets: [newTicket({ id: "a" })] });
  return dir;
}

async function cleanup(dir: string) {
  await store.forget(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

test("attachments leave the frequently rewritten snapshot and hydrate on reads", async () => {
  const dir = scratch("assets");
  try {
    const attachment = { id: "asset", name: "notes.txt", mediaType: "text/plain", dataUrl: "data:text/plain;base64,aGVsbG8=" };
    const project = { ...readProject(dir)!, attachments: [attachment] };
    writeProject(dir, project);
    const snapshot = fs.readFileSync(path.join(dir, ".autoproject", "project.json"), "utf8");
    assert.equal(snapshot.includes(attachment.dataUrl), false);
    assert.deepEqual(readProject(dir)!.attachments, [attachment]);
    store.setProject(dir, { ...store.getProject(dir)!, description: "changed" });
    await store.flush(dir);
    assert.deepEqual(readProject(dir)!.attachments, [attachment]);
    assert.equal(fs.readdirSync(path.join(dir, ".autoproject", "attachments")).length, 1);
  } finally { await cleanup(dir); }
});

test("overlapping flushes preserve edits made while an earlier write is pending", async () => {
  const dir = scratch("serialized");
  try {
    store.setNotes(dir, ["first"]);
    const first = store.flush(dir);
    store.setNotes(dir, ["second"]);
    const second = store.flush(dir);
    store.appendLog(dir, "a", { kind: "text", text: "still running", ts: 1 });
    await Promise.all([first, second]);
    assert.deepEqual(readProject(dir)!.notes, ["second"]);
    assert.equal(readProject(dir)!.tickets[0].log.length, 1);
    assert.equal(fs.readdirSync(path.join(dir, ".autoproject")).some((name) => name.endsWith(".tmp")), false);
  } finally { await cleanup(dir); }
});

test("failed writes report the error, retain dirty state, and retry", async () => {
  const dir = scratch("retry");
  const file = path.join(dir, ".autoproject", "project.json");
  const events: ProjectEvent[] = [];
  const unsubscribe = store.subscribe(dir, (event) => events.push(event));
  try {
    const original = fs.readFileSync(file, "utf8");
    store.setNotes(dir, ["must survive"]);
    fs.renameSync(file, file + ".backup");
    fs.mkdirSync(file);
    await assert.rejects(store.flush(dir));
    assert.equal(fs.readFileSync(file + ".backup", "utf8"), original);
    assert.ok(store.persistenceStatus(dir));
    assert.ok(events.some((event) => event.type === "persistence" && event.error));
    fs.rmdirSync(file);
    fs.renameSync(file + ".backup", file);
    await store.flush(dir);
    assert.deepEqual(readProject(dir)!.notes, ["must survive"]);
    assert.equal(store.persistenceStatus(dir), null);
  } finally { unsubscribe(); await cleanup(dir); }
});

test("bounded live output retains full paged history across a reload", async () => {
  const dir = scratch("history");
  try {
    for (let index = 0; index < TICKET_LOG_CAP + 20; index++) {
      store.appendLog(dir, "a", { kind: "text", text: String(index), ts: index });
    }
    store.appendChat(dir, Array.from({ length: CHAT_CAP + 10 }, (_, index) => ({ kind: "text", text: String(index), ts: index, mode: "act" })));
    assert.equal(store.getProject(dir)!.tickets[0].log.length, TICKET_LOG_CAP);
    assert.equal(store.getProject(dir)!.chat.length, CHAT_CAP);
    await store.forget(dir);
    assert.equal(readProject(dir)!.tickets[0].log.length, TICKET_LOG_CAP);
    const texts: string[] = [];
    let cursor: number | null = 0;
    do {
      const page = await readProjectHistory(dir, { ticketId: "a", cursor, limit: 111 });
      texts.push(...page.entries.map((entry) => entry.text));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(texts, Array.from({ length: TICKET_LOG_CAP + 20 }, (_, index) => String(index)));
    const before = fs.statSync(path.join(dir, ".autoproject", "history.jsonl")).size;
    store.getProject(dir);
    await store.flush(dir);
    assert.equal(fs.statSync(path.join(dir, ".autoproject", "history.jsonl")).size, before);
  } finally { await cleanup(dir); }
});

test("ticket clear events survive JSON serialization", async () => {
  const dir = scratch("unset");
  try {
    store.updateTicket(dir, "a", (ticket) => ({ ...ticket, sessionId: "old", stats: { runs: 1, ms: 1, tokens: 1, costUsd: 0, runsWithoutCost: 1, rejections: 0 } }));
    const events: ProjectEvent[] = [];
    const unsubscribe = store.subscribe(dir, (event) => events.push(JSON.parse(JSON.stringify(event))));
    store.updateTicket(dir, "a", (ticket) => ({ ...ticket, sessionId: undefined, stats: undefined }));
    unsubscribe();
    assert.deepEqual(events, [{ type: "ticket", id: "a", patch: {}, unset: ["sessionId", "stats"] }]);
  } finally { await cleanup(dir); }
});

test("erase validation refuses unmanaged paths, protected roots, and symlinks", async () => {
  const dir = scratch("managed");
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-unmanaged-")));
  try {
    assert.equal(assertManagedProject(dir), dir);
    assert.throws(() => assertManagedProject(outside), /managed/);
    assert.throws(() => assertManagedProject(os.homedir()), /protected/);
    assert.throws(() => assertManagedProject(path.parse(dir).root), /protected/);
    const link = path.join(outside, "alias");
    fs.symlinkSync(dir, link, "dir");
    assert.throws(() => assertManagedProject(link), /symbolic/);
  } finally { await cleanup(dir); fs.rmSync(outside, { recursive: true, force: true }); }
});


test("history preserves repeated identical messages as distinct events", async () => {
  const dir = scratch("duplicates");
  try {
    const line = { kind: "text" as const, text: "same", ts: 1 };
    store.appendLog(dir, "a", line);
    store.appendLog(dir, "a", line);
    await store.flush(dir);
    assert.deepEqual((await readProjectHistory(dir, { ticketId: "a" })).entries, [line, line]);
  } finally { await cleanup(dir); }
});

test("history byte cursors preserve Unicode records spanning multiple input chunks", async () => {
  const dir = scratch("unicode-history");
  try {
    const texts = ["Before: café 🧪", "🌍".repeat(40000), "After: 日本語"];
    texts.forEach((text, index) => store.appendLog(dir, "a", { kind: "text", text, ts: index }));
    await store.flush(dir);
    const first = await readProjectHistory(dir, { ticketId: "a", limit: 1 });
    assert.equal(first.entries[0].text, texts[0]);
    assert.ok(first.nextCursor! > 0);
    const second = await readProjectHistory(dir, { ticketId: "a", limit: 1, cursor: first.nextCursor! });
    assert.equal(second.entries[0].text, texts[1]);
    assert.ok(second.nextCursor! > 128 * 1024);
    const third = await readProjectHistory(dir, { ticketId: "a", limit: 1, cursor: second.nextCursor! });
    assert.deepEqual(third.entries.map((entry) => entry.text), [texts[2]]);
    assert.equal(third.nextCursor, null);
    const bytes = fs.readFileSync(path.join(dir, ".autoproject", "history.jsonl"));
    assert.equal(JSON.parse(bytes.subarray(second.nextCursor!).toString("utf8").trim()).entry.text, texts[2]);
  } finally { await cleanup(dir); }
});

test("legacy history migration removes retried IDs but keeps identical distinct events", async () => {
  const dir = scratch("history-migration");
  try {
    const same = { kind: "text", text: "Repeated 🧪", ts: 1 };
    const records = [
      { id: "first", ticketId: "a", entry: same },
      { id: "second", ticketId: "a", entry: same },
      { id: "first", ticketId: "a", entry: same },
      { id: "third", ticketId: "a", entry: { ...same, text: "Last" } },
      { id: "second", ticketId: "a", entry: same },
    ];
    const file = path.join(dir, ".autoproject", "history.jsonl");
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record) + "\n").join(""));
    fs.writeFileSync(path.join(dir, ".autoproject", "history.seeded"), "1");
    const first = await readProjectHistory(dir, { ticketId: "a", limit: 2 });
    const second = await readProjectHistory(dir, { ticketId: "a", cursor: first.nextCursor!, limit: 2 });
    assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.text), [same.text, same.text, "Last"]);
    assert.equal(second.nextCursor, null);
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 3);
    assert.equal(fs.existsSync(path.join(dir, ".autoproject", "history.version")), true);
    assert.equal(fs.readdirSync(path.join(dir, ".autoproject")).some((name) => name.startsWith(".history-migration-")), false);
  } finally { await cleanup(dir); }
});

test("snapshot failure never appends already durable history again on retry", async () => {
  const dir = scratch("journal-retry");
  const file = path.join(dir, ".autoproject", "project.json");
  try {
    store.appendLog(dir, "a", { kind: "text", text: "Committed once", ts: 1 });
    fs.renameSync(file, file + ".backup");
    fs.mkdirSync(file);
    await assert.rejects(store.flush(dir));
    const journal = path.join(dir, ".autoproject", "history.jsonl");
    const before = fs.readFileSync(journal, "utf8");
    fs.rmdirSync(file);
    fs.renameSync(file + ".backup", file);
    await store.flush(dir);
    assert.equal(fs.readFileSync(journal, "utf8"), before);
    store.appendLog(dir, "a", { kind: "text", text: "Next entry", ts: 2 });
    await store.flush(dir);
    assert.deepEqual((await readProjectHistory(dir, { ticketId: "a" })).entries.map((entry) => entry.text), ["Committed once", "Next entry"]);
  } finally { await cleanup(dir); }
});
