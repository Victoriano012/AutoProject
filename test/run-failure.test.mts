import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeCodex } from "./fake-codex.mts";

const LIMIT = "You've hit your usage limit. Try again at 3:08 AM.";

test("a failed run says why on the card, and Retry resends the feedback it failed on", async (t) => {
  // config.ts reads the home directory on import: mock it first, so no real
  // settings or provider are ever used.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-run-failure-"));
  t.mock.method(os, "homedir", () => home);
  const dir = path.join(home, "project");
  fs.mkdirSync(dir);
  // Codex reports a usage limit as an `error` and a failed turn, after the thread opens.
  const sentTurns = fakeCodex(t, `
emit("error", { error: { message: ${JSON.stringify(LIMIT)} }, willRetry: false });
complete("failed", { message: ${JSON.stringify(LIMIT)} });`);

  const { writeConfig } = await import("../lib/config.ts");
  const runs = await import("../lib/server/runs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const { finishProjectRemoval } = await import("../lib/server/project-lifecycle.ts");
  t.after(async () => {
    runs.registry.removing.add(dir);
    await store.forget(dir);
    finishProjectRemoval(dir);
    fs.rmSync(home, { recursive: true, force: true });
  });

  writeConfig({ model: "gpt-6-astra" });
  writeProject(dir, {
    ...defaultProject("Failures", dir),
    workers: [{ id: "w", n: 1, description: "Models", sessionId: "codex:thread-0" }],
    tickets: [{ id: "t", title: "Model list", description: "List the models", files: [],
      status: "review", workerId: "w", sessionId: "codex:thread-0", log: [] }],
  });
  const ticket = () => store.getProject(dir)!.tickets[0];
  const sent = () => sentTurns().map((turn) => turn.text);

  await runs.rejectTicket(dir, "t", "Show only the latest models");
  assert.equal(ticket().status, "error");
  assert.deepEqual(ticket().log.filter((e) => e.kind === "error").map((e) => e.text), [LIMIT]);

  await runs.runTicket(dir, "t"); // the card's Retry
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /Human review feedback[\s\S]*Show only the latest models/);
  assert.doesNotMatch(sent()[1], /this is a new ticket/);
  assert.equal(ticket().log.filter((e) => e.kind === "user" && e.text === "Show only the latest models").length, 1);
});
