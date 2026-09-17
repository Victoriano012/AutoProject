import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardIndex, createBoardTicketSelector, normalizeFile } from "../lib/board-index.ts";
import type { Ticket } from "../lib/types.ts";

const ticket = (id: string, data: Partial<Ticket> = {}): Ticket => ({
  id, title: id, description: "", status: "todo", log: [], ...data,
});

test("indexes all shared files once, ordered by holder and mirrored only for waiting cards", () => {
  const a = ticket("a", { status: "running", files: ["src/b.ts", "./src/a.ts", "src/a.ts"] });
  const b = ticket("b", { status: "running", files: ["src/a.ts"], workerId: "w" });
  const c = ticket("c", { files: ["src/x/../a.ts", "src/b.ts"], workerId: "w" });
  const review = ticket("review", { status: "review", files: ["src/a.ts"] });
  const done = ticket("done", { status: "done", files: ["src/a.ts"] });
  const index = createBoardIndex([a, b, c, review, done]);
  assert.deepEqual(index.fileHolders("c"), [
    { file: "src/a.ts", files: ["src/a.ts", "src/b.ts"], by: a },
    { file: "src/a.ts", files: ["src/a.ts"], by: b },
  ]);
  assert.deepEqual(index.fileBlockees("a"), [{ file: "src/a.ts", files: ["src/a.ts", "src/b.ts"], who: c }]);
  assert.equal(index.fileHolders("review").length, 2);
  assert.deepEqual(index.fileHolders("done"), []);
  assert.equal(index.workerBusyOn("c"), b);
  assert.equal(index.workerBusyOn("b"), null);
  assert.deepEqual(index.fileHolders("missing"), []);
});

test("path normalization keeps absolute paths separate and ignores empty declarations", () => {
  assert.equal(normalizeFile(" ./src//nested/../a.ts "), "src/a.ts");
  assert.equal(normalizeFile("src\\a.ts"), "src/a.ts");
  assert.equal(normalizeFile("../../src/a.ts"), "../../src/a.ts");
  assert.equal(normalizeFile("/../src/a.ts"), "/src/a.ts");
  const index = createBoardIndex([
    ticket("holder", { status: "running", files: ["", " ", "/src/a.ts"] }),
    ticket("candidate", { files: ["", "src/a.ts"] }),
  ]);
  assert.deepEqual(index.fileHolders("candidate"), []);
});

test("matches a pairwise reference over mixed boards", () => {
  for (const count of [10, 50, 200]) {
    const tickets = Array.from({ length: count }, (_, i) => ticket(String(i), {
      status: (["todo", "running", "review", "done", "error"] as const)[i % 5],
      files: [`src/${i % 13}.ts`, `src/${i % 7}.ts`], workerId: `w${i % 9}`,
    }));
    const index = createBoardIndex(tickets);
    for (const t of tickets) {
      const holders = t.status === "done" ? [] : tickets.flatMap((other) => {
        if (other.id === t.id || other.status !== "running") return [];
        const files = [...new Set(t.files)].filter((f) => other.files!.includes(f)).sort();
        return files.length ? [{ file: files[0], files, by: other }] : [];
      });
      assert.deepEqual(index.fileHolders(t.id), holders);
      assert.equal(index.workerBusyOn(t.id), tickets.find((o) => o.id !== t.id && o.workerId === t.workerId && o.status === "running") ?? null);
    }
  }
});

test("board metadata is referentially stable when only logs, sessions or statistics change", () => {
  const select = createBoardTicketSelector();
  const a = ticket("a", { files: ["a.ts"] });
  const b = ticket("b");
  const before = select({ project: { tickets: [a, b] } });
  const logged = { ...a, log: [{ kind: "text" as const, text: "working", ts: 1 }], sessionId: "session" };
  assert.equal(select({ project: { tickets: [logged, b] } }), before);
  const changed = select({ project: { tickets: [{ ...logged, status: "running" }, b] } });
  assert.notEqual(changed, before);
  assert.equal(changed[1], before[1]);
  assert.notEqual(changed[0], before[0]);
  assert.deepEqual(changed[0].log, []);
  assert.equal(select({ project: { tickets: [b] } }).length, 1);
});
