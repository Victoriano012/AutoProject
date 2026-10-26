import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const LIMIT = "You've hit your usage limit. Try again at 3:08 AM.";

test("a failed run says why on the card, and Retry resends the feedback it failed on", async (t) => {
  // config.ts reads the home directory on import: mock it first, so no real
  // settings or provider are ever used.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-run-failure-"));
  t.mock.method(os, "homedir", () => home);
  const dir = path.join(home, "project");
  fs.mkdirSync(dir);
  // Codex reports a usage limit as `error` + `turn.failed`, after the thread starts.
  const prompts = path.join(home, "prompts.jsonl");
  const cli = path.join(home, "fake-codex.cjs");
  fs.writeFileSync(cli, `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => stdin += chunk);
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(stdin) + "\\n");
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "thread.started", thread_id: "thread-1" });
  emit({ type: "error", message: ${JSON.stringify(LIMIT)} });
  emit({ type: "turn.failed", error: { message: ${JSON.stringify(LIMIT)} } });
});`, { mode: 0o700 });
  const previous = process.env.AUTOPROJECT_CODEX_PATH;
  process.env.AUTOPROJECT_CODEX_PATH = cli;

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
    if (previous === undefined) delete process.env.AUTOPROJECT_CODEX_PATH;
    else process.env.AUTOPROJECT_CODEX_PATH = previous;
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
  const sent = () => fs.readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);

  await runs.rejectTicket(dir, "t", "Show only the latest models");
  assert.equal(ticket().status, "error");
  assert.deepEqual(ticket().log.filter((e) => e.kind === "error").map((e) => e.text), [LIMIT]);

  await runs.runTicket(dir, "t"); // the card's Retry
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /Human review feedback[\s\S]*Show only the latest models/);
  assert.doesNotMatch(sent()[1], /this is a new ticket/);
  assert.equal(ticket().log.filter((e) => e.kind === "user" && e.text === "Show only the latest models").length, 1);
});
