import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelCatalog, modelCatalog, catalogModels } from "../lib/server/model-catalog.ts";
import { reasoningEffortsForModel, type ModelChoice } from "../lib/models.ts";
import { codexArgs } from "../lib/server/codex.ts";
import { geminiArgs } from "../lib/server/gemini.ts";
import { claudeReasoningOptions } from "../lib/server/claude.ts";
import { providerForModel, resumableSession } from "../lib/server/model-settings.ts";

test("Settings, config validation, sessions and execution share discovered metadata; refresh preserves saved settings", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-discovered-settings-"));
  t.mock.method(os, "homedir", () => home);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rows: ModelChoice[] = [
    { value: "gpt-6.1-sol", label: "Sol 6.1", provider: "codex", reasoningEfforts: ["low", "high", "ultra"] },
    { value: "sonnet", label: "Sonnet", provider: "claude", reasoningEfforts: ["low", "high"] },
    { value: "gemini-new-high", label: "Gemini New", provider: "gemini", reasoningEfforts: ["low", "high"], reasoningModels: { low: "gemini-new-low", high: "gemini-new-high" } },
    { value: "gpt-unknown", label: "Unknown", provider: "codex", reasoningEfforts: [] },
  ];
  const cache = createModelCatalog({ file: () => path.join(home, "catalog.json"), discover: async (p) => rows.filter((m) => m.provider === p) });
  const snapshot = await cache.refresh();
  t.mock.method(modelCatalog, "read", () => snapshot);
  const refreshes: boolean[] = [];
  t.mock.method(modelCatalog, "refresh", async (force = false) => { refreshes.push(force); return snapshot; });
  const { GET, PUT } = await import("../app/api/config/route.ts");
  const modelsRoute = await import("../app/api/models/route.ts");
  const { readConfig, writeConfig, selectedAgentSettings } = await import("../lib/config.ts");
  const put = (body: unknown) => PUT(new Request("http://localhost/api/config", { method: "PUT", body: JSON.stringify(body) }));
  writeConfig({ model: "gpt-6.1-sol", reasoningEffort: "ultra" });
  for (const fetchModels of [modelsRoute.GET, modelsRoute.POST]) {
    const response = await fetchModels();
    const catalog = await response.json();
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(catalog.models, catalogModels(snapshot));
    assert.deepEqual(readConfig(), { model: "gpt-6.1-sol", reasoningEffort: "ultra" });
  }
  assert.deepEqual(refreshes, [false, true]);
  for (const model of rows) {
    for (const effort of reasoningEffortsForModel(model.value, rows)) {
      assert.equal((await put({ model: model.value, reasoningEffort: effort })).status, 200);
      assert.equal((await (await GET()).json()).reasoningEffort, effort);
      assert.deepEqual(selectedAgentSettings(), { model: model.value, reasoningEffort: effort });
      const request = { model: model.value, reasoningEffort: effort };
      if (model.provider === "codex") assert.ok(codexArgs(request).includes(`model_reasoning_effort="${effort}"`));
      if (model.provider === "claude") assert.deepEqual(claudeReasoningOptions(request), { effort });
      if (model.provider === "gemini") assert.ok(geminiArgs(request).includes(model.reasoningModels![effort]!));
    }
  }
  assert.equal((await put({ model: "gemini-new-high", reasoningEffort: "medium" })).status, 400);
  assert.equal((await put({ model: "gpt-unknown", reasoningEffort: "high" })).status, 400);
  assert.equal((await put({ model: "gpt-unknown" })).status, 200);
  assert.equal(codexArgs({ model: "gpt-unknown", reasoningEffort: "high" }).includes("--config"), false);
  assert.equal(providerForModel("sonnet"), "claude");
  assert.equal(resumableSession("codex:thread", "sonnet"), undefined);
  assert.deepEqual(resumableSession("claude:session", "sonnet"), { stored: "claude:session", raw: "session" });
  writeConfig({ model: "saved-unlisted-model" });
  const response = await (await modelsRoute.GET()).json();
  assert.equal(response.models.at(-1).value, "saved-unlisted-model");
  assert.deepEqual(readConfig(), { model: "saved-unlisted-model" });
});
