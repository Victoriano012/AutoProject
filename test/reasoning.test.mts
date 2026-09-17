import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CHOICES, reasoningEffortsForModel, resolveReasoningEffort } from "../lib/models.ts";
import { claudeReasoningOptions } from "../lib/server/agent.ts";
import { codexArgs } from "../lib/server/codex.ts";
import { geminiArgs } from "../lib/server/gemini.ts";

test("every adjustable model defaults to High; Haiku omits effort", () => {
  for (const model of MODEL_CHOICES) {
    const expected = model.value === "claude-haiku-4-5-20251001" ? undefined : "high";
    assert.equal(resolveReasoningEffort(model.value), expected, model.value);
    assert.equal(resolveReasoningEffort(model.value, "invalid"), expected, model.value);
  }
  assert.deepEqual(claudeReasoningOptions({ model: "claude-haiku-4-5-20251001", reasoningEffort: "high" }), {});
  assert.equal(resolveReasoningEffort("custom-model", "high"), undefined);
});

test("switching models preserves compatible effort and resets incompatible effort to High", () => {
  assert.equal(resolveReasoningEffort("gemini-3.1-pro-high", "medium"), "high");
  assert.equal(resolveReasoningEffort("gpt-5.6-luna", "ultra"), "high");
  assert.equal(resolveReasoningEffort("claude-opus-5", "ultra"), "high");
  assert.equal(resolveReasoningEffort("gemini-3.7-flash-high", "low"), "low");
  assert.deepEqual(reasoningEffortsForModel("gemini-3.1-pro-high"), ["low", "high"]);
  assert.deepEqual(reasoningEffortsForModel("gemini-3.7-flash-high"), ["low", "medium", "high"]);
});

test("Claude sends each supported effort using the SDK effort option", () => {
  for (const model of MODEL_CHOICES.filter((model) => model.provider === "claude")) {
    for (const effort of model.reasoningEfforts) {
      assert.deepEqual(claudeReasoningOptions({ model: model.value, reasoningEffort: effort }), { effort });
    }
  }
  assert.deepEqual(claudeReasoningOptions({ model: "claude-fable-5-1" }), { effort: "high" });
});

test("Codex sends each supported effort for both new and resumed turns", () => {
  for (const model of MODEL_CHOICES.filter((model) => model.provider === "codex")) {
    for (const effort of model.reasoningEfforts) {
      for (const sessionId of [undefined, "codex:existing-thread"]) {
        const args = codexArgs({ model: model.value, reasoningEffort: effort, sessionId, workspaceDir: "/tmp" });
        assert.equal(args[args.indexOf("--config") + 1], `model_reasoning_effort="${effort}"`);
      }
    }
  }
});

test("Gemini uses the selected variant even when a saved model pins High", () => {
  for (const model of MODEL_CHOICES.filter((model) => model.provider === "gemini")) {
    for (const effort of model.reasoningEfforts) {
      for (const sessionId of [undefined, "gemini:existing-conversation"]) {
        const args = geminiArgs({ model: model.value, reasoningEffort: effort, sessionId });
        assert.equal(args[args.indexOf("--model") + 1], model.value.replace(/-high$/, `-${effort}`));
        assert.equal(args.includes("--effort"), false);
      }
    }
  }
  const args = geminiArgs({ model: "gemini-3.1-pro-high", reasoningEffort: "medium" });
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.1-pro-high");
});
