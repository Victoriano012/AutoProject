import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("settings API persists effort, validates model compatibility, and reads legacy configs", async (t) => {
  // Keep all writes in a disposable home; never touch the user's live settings.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-config-test-"));
  t.mock.method(os, "homedir", () => home);
  try {
    const { readConfig, writeConfig, selectedAgentSettings } = await import("../lib/config.ts");
    const { GET, PUT } = await import("../app/api/config/route.ts");
    const put = (body: unknown) => PUT(new Request("http://localhost/api/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }));

    assert.equal((await (await GET()).json()).reasoningEffort, "high");
    writeConfig({ model: "gpt-6-astra" });
    assert.deepEqual(selectedAgentSettings(), { model: "gpt-6-astra", reasoningEffort: "high" });
    assert.equal((await put({ model: "gpt-6-astra", reasoningEffort: "ultra" })).status, 200);
    assert.deepEqual(readConfig(), { model: "gpt-6-astra", reasoningEffort: "ultra" });
    assert.equal((await (await GET()).json()).reasoningEffort, "ultra");
    assert.equal(selectedAgentSettings().reasoningEffort, "ultra");
    assert.equal(selectedAgentSettings("gemini-3.1-pro-high").reasoningEffort, "high");

    for (const body of [
      { model: "gemini-3.1-pro-high", reasoningEffort: "medium" },
      { model: "claude-haiku-4-5-20251001", reasoningEffort: "high" },
      { model: "gpt-5.6-luna", reasoningEffort: "ultra" },
      { reasoningEffort: "invalid" },
      { model: 123 },
      null,
    ]) {
      assert.equal((await put(body)).status, 400);
      assert.deepEqual(readConfig(), { model: "gpt-6-astra", reasoningEffort: "ultra" });
    }
    assert.equal((await PUT(new Request("http://localhost/api/config", { method: "PUT", body: "{" }))).status, 400);
    await put({ model: "gemini-3.1-pro-high" });
    assert.equal(selectedAgentSettings().reasoningEffort, "high");
    await put({ reasoningEffort: "low" });
    assert.deepEqual(selectedAgentSettings(), { model: "gemini-3.1-pro-high", reasoningEffort: "low" });
    await put({ model: "claude-haiku-4-5-20251001" });
    assert.equal(selectedAgentSettings().reasoningEffort, undefined);
    assert.equal((await (await GET()).json()).reasoningEffort, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
