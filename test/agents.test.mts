import assert from "node:assert/strict";
import test from "node:test";
import {
  resumableSession,
  sessionProvider,
  tagSession,
} from "../lib/agent-session.ts";
import { MODEL_CHOICES, providerForModel } from "../lib/models.ts";
import { codexThread } from "../lib/server/codex.ts";
import { geminiArgs } from "../lib/server/gemini.ts";

test("settings expose only the requested Codex and Gemini model families", () => {
  assert.deepEqual(
    MODEL_CHOICES.filter((model) => model.provider === "codex").map(
      (model) => model.value
    ),
    ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  );
  assert.deepEqual(
    MODEL_CHOICES.filter((model) => model.provider === "gemini").map(
      (model) => model.value
    ),
    ["gemini-3.7-flash-high", "gemini-3.1-pro-high"]
  );
  assert.equal(providerForModel("gpt-6-astra"), "codex");
  assert.equal(providerForModel("gpt-5.6-sol"), "codex");
  assert.equal(providerForModel("claude-sonnet-5"), "claude");
  assert.equal(providerForModel("gemini-3.7-flash-high"), "gemini");
  assert.equal(providerForModel("gemini-3.1-pro-high"), "gemini");
  assert.equal(providerForModel("gemini-3.7-flash"), "gemini");
});

test("legacy sessions remain Claude sessions and providers never cross-resume", () => {
  assert.equal(sessionProvider("old-claude-id"), "claude");
  assert.deepEqual(resumableSession("old-claude-id", "claude-opus-5"), {
    stored: "old-claude-id",
    raw: "old-claude-id",
  });
  assert.equal(resumableSession("old-claude-id", "gpt-5.6-sol"), undefined);
  assert.equal(resumableSession("old-claude-id", "gemini-3.7-flash-high"), undefined);

  const codex = tagSession("codex", "thread-123");
  assert.equal(codex, "codex:thread-123");
  assert.equal(sessionProvider(codex), "codex");
  assert.equal(resumableSession(codex, "claude-opus-5"), undefined);
  assert.equal(resumableSession(codex, "gemini-3.7-flash-high"), undefined);
  assert.deepEqual(resumableSession(codex, "gpt-5.6-terra"), {
    stored: codex,
    raw: "thread-123",
  });

  const gemini = tagSession("gemini", "conv-789");
  assert.equal(gemini, "gemini:conv-789");
  assert.equal(sessionProvider(gemini), "gemini");
  assert.equal(resumableSession(gemini, "claude-opus-5"), undefined);
  assert.equal(resumableSession(gemini, "gpt-5.6-sol"), undefined);
  assert.deepEqual(resumableSession(gemini, "gemini-3.1-pro-high"), {
    stored: gemini,
    raw: "conv-789",
  });
});

test("new Codex work opens a thread with the selected model and workspace", () => {
  assert.deepEqual(codexThread({
    model: "gpt-5.6-sol",
    workspaceDir: "/tmp/autoproject-test-workspace",
    writeAccess: true,
  }), {
    method: "thread/start",
    params: {
      model: "gpt-5.6-sol",
      cwd: "/tmp/autoproject-test-workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: "high" },
      threadSource: "chatgpt_hidden",
    },
  });
});

test("Codex threads stay out of the ChatGPT app and still resume", () => {
  const req = { model: "gpt-5.6-sol", workspaceDir: "/tmp/autoproject-test-workspace" };
  assert.equal(codexThread(req).params.threadSource, "chatgpt_hidden");
  // thread/resume takes no source: the thread keeps the one it started with.
  const resumed = codexThread({ ...req, sessionId: "codex:thread-1" });
  assert.equal(resumed.method, "thread/resume");
  assert.equal("threadSource" in resumed.params, false);
});

test("Codex planner resumes keep their thread, read-only", () => {
  assert.deepEqual(codexThread({
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    sessionId: "codex:thread-456",
    workspaceDir: "/tmp/autoproject-test-workspace",
    writeAccess: false,
  }), {
    method: "thread/resume",
    params: {
      threadId: "thread-456",
      model: "gpt-5.6-luna",
      cwd: "/tmp/autoproject-test-workspace",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { model_reasoning_effort: "max" },
    },
  });
});

test("new Gemini work runs through agy with the selected model and write access", () => {
  const args = geminiArgs({
    model: "gemini-3.7-flash-high",
    workspaceDir: "/tmp/autoproject-test-workspace",
    writeAccess: true,
  });
  assert.deepEqual(args, [
    "--output-format",
    "stream-json",
    "--model",
    "gemini-3.7-flash-high",
    "--dangerously-skip-permissions",
  ]);
});

test("Gemini planner resumes keep their conversation ID and structured-output schema", () => {
  const args = geminiArgs(
    {
      model: "gemini-3.1-pro-high",
      reasoningEffort: "low",
      sessionId: "gemini:conv-456",
      workspaceDir: "/tmp/autoproject-test-workspace",
      writeAccess: false,
    },
    "/tmp/schema.json"
  );
  assert.deepEqual(args, [
    "--output-format",
    "stream-json",
    "--conversation",
    "conv-456",
    "--model",
    "gemini-3.1-pro-low",
    "--json-schema",
    "/tmp/schema.json",
  ]);
});

test("Gemini model without effort suffix defaults effort to high", () => {
  const args = geminiArgs({
    model: "gemini-3.7-flash",
    workspaceDir: "/tmp/autoproject-test-workspace",
    writeAccess: false,
  });
  assert.deepEqual(args, [
    "--output-format",
    "stream-json",
    "--model",
    "gemini-3.7-flash-high",
  ]);
});
