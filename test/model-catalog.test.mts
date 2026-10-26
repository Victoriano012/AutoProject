import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelCatalog, catalogModels, knownModels, MODEL_CACHE_TTL_MS } from "../lib/server/model-catalog.ts";
import { parseCodexModels, parseClaudeModels, parseGeminiModels, discoverCodex, discoverGemini } from "../lib/server/model-discovery.ts";
import { providerForModel, reasoningEffortsForModel, resolveReasoningEffort, withSelectedModel, type ModelChoice } from "../lib/models.ts";

function setEnv(t: test.TestContext, key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

const sol = parseCodexModels([{ id: "internal-id", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "ultra" }],
  defaultReasoningEffort: "low" }])[0];

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("discovery learns Sol-6.1 and capabilities without inferring from names", () => {
  assert.equal(sol.value, "gpt-6.1-sol");
  assert.equal(providerForModel(sol.value, [sol]), "codex");
  assert.deepEqual(reasoningEffortsForModel(sol.value, [sol]), ["low", "high", "ultra"]);
  assert.equal(resolveReasoningEffort(sol.value, "ultra", [sol]), "ultra");
  const unknown = parseCodexModels([{ model: "gpt-future", supportedReasoningEfforts: [{ reasoningEffort: "future-effort" }] }]);
  assert.deepEqual(unknown[0].reasoningEfforts, []);
  assert.equal(resolveReasoningEffort("gpt-future", "ultra", unknown), undefined);
  const medium = parseCodexModels([{ model: "medium-only", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }]);
  assert.equal(resolveReasoningEffort("medium-only", undefined, medium), "medium");
  assert.deepEqual(parseCodexModels([{ model: "hidden", hidden: true }, { id: "wrong" }]), []);
});

test("Claude aliases and canonical IDs share explicitly reported capabilities", () => {
  const models = parseClaudeModels([
    { value: "sonnet", resolvedModel: "claude-new-sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["low", "high"] },
    { value: "unknown", displayName: "Unknown", description: "" },
    { value: "disabled", displayName: "Disabled", description: "", supportsEffort: false, supportedEffortLevels: ["high"] },
  ]);
  for (const id of ["sonnet", "claude-new-sonnet"]) {
    assert.equal(providerForModel(id, models), "claude");
    assert.deepEqual(reasoningEffortsForModel(id, models), ["low", "high"]);
  }
  assert.deepEqual(reasoningEffortsForModel("unknown", models), []);
  assert.deepEqual(reasoningEffortsForModel("disabled", models), []);
});

test("Gemini offers only listed variants and ignores other providers and progress text", () => {
  const models = parseGeminiModels("Fetching available models...\ngemini-new-high\tGemini New (High)\ngemini-new-low\tGemini New (Low)\nclaude-other\tOther\ngpt-oss-medium\tOther\ngemini-unknown\tUnknown\n");
  assert.equal(models.length, 2);
  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  assert.deepEqual(models[0].reasoningModels, { low: "gemini-new-low", high: "gemini-new-high" });
  assert.deepEqual(models[1].reasoningEfforts, []);
  assert.equal(resolveReasoningEffort("gemini-new-high", "medium", models), "high");
});

test("bounded cache coalesces requests, expires, refreshes manually, and persists partial successes", async (t) => {
  const dir = fixture(t);
  const file = () => path.join(dir, "catalog.json");
  let now = 1000;
  let calls = 0;
  let fail = false;
  const discover = async (provider: string): Promise<ModelChoice[]> => {
    calls++;
    if (provider !== "codex" || fail) throw new Error("private diagnostic must not escape");
    return [sol];
  };
  const cache = createModelCatalog({ file, now: () => now, discover });
  const [first, duplicate] = await Promise.all([cache.refresh(), cache.refresh(true)]);
  assert.deepEqual(first, duplicate);
  assert.equal(calls, 3);
  assert.equal(first.providers.codex.source, "discovered");
  assert.equal(first.providers.claude.source, "bundled");
  assert.equal(JSON.stringify(first).includes("private diagnostic"), false);
  now += MODEL_CACHE_TTL_MS - 1;
  await cache.refresh();
  assert.equal(calls, 3);
  now++;
  fail = true;
  const stale = await cache.refresh();
  assert.equal(calls, 6);
  assert.equal(stale.providers.codex.source, "cached");
  assert.deepEqual(stale.providers.codex.models, [sol]);
  await cache.refresh();
  assert.equal(calls, 6, "failures are also cached");
  await cache.refresh(true);
  assert.equal(calls, 9);
  const restarted = createModelCatalog({ file, now: () => now, discover });
  assert.deepEqual((await restarted.refresh()).providers.codex.models, [sol]);
  assert.equal(calls, 9, "fresh disk snapshots survive restart");
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
});

test("removed saved selections remain visible and retain routing without changing defaults", async (t) => {
  const dir = fixture(t);
  const alias: ModelChoice = { value: "sonnet", label: "Sonnet", provider: "claude", reasoningEfforts: ["high"] };
  let choices = [alias];
  const cache = createModelCatalog({ file: () => path.join(dir, "catalog.json"), discover: async (p) => {
    if (p !== "claude") throw new Error("offline");
    return choices;
  } });
  await cache.refresh();
  choices = [{ ...alias, value: "next-sonnet" }];
  const latest = await cache.refresh(true);
  const visible = withSelectedModel(catalogModels(latest), "sonnet", knownModels(latest));
  assert.equal(visible.find((m) => m.value === "sonnet")?.provider, "claude");
  assert.equal(providerForModel("sonnet", knownModels(latest)), "claude");
  const unknown = withSelectedModel(visible, "custom-saved-model");
  assert.equal(unknown.at(-1)?.value, "custom-saved-model");
  assert.deepEqual(unknown.at(-1)?.reasoningEfforts, []);
});

test("corrupt disk cache falls back, while a successful catalog can override bundled capabilities with unknown", async (t) => {
  const dir = fixture(t);
  const file = () => path.join(dir, "catalog.json");
  fs.writeFileSync(file(), '{"version":1,"providers":null}');
  const cache = createModelCatalog({ file, discover: async (p) => {
    if (p !== "codex") throw new Error("offline");
    return [{ value: "gpt-6-astra", label: "Astra", provider: "codex", reasoningEfforts: [] }];
  } });
  assert.ok(catalogModels(cache.read()).length);
  const result = await cache.refresh();
  assert.equal(resolveReasoningEffort("gpt-6-astra", "ultra", knownModels(result)), undefined);
});

test("Codex RPC initializes, handles pagination, and never starts inference", async (t) => {
  const dir = fixture(t);
  const executable = path.join(dir, "codex");
  const log = path.join(dir, "requests.jsonl");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const req = JSON.parse(line);
  if (req.method === 'initialize') console.log(JSON.stringify({id:req.id,result:{}}));
  if (req.method === 'model/list') console.log(JSON.stringify({ id:req.id,result:{data:[{model:req.params.cursor ? 'gpt-next' : 'gpt-6.1-sol', supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:req.params.cursor ? null : 'page2'}}));
});
`, { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  const models = await discoverCodex(2000);
  assert.deepEqual(models.map((m) => m.value), ["gpt-6.1-sol", "gpt-next"]);
  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((m) => m.method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.equal(messages[3].params.cursor, "page2");
});

test("CLI discovery is bounded and rejects missing tools and malformed responses", async (t) => {
  const dir = fixture(t);
  const executable = path.join(dir, "fake-tool");
  setEnv(t, "AUTOPROJECT_CODEX_PATH", path.join(dir, "missing"));
  await assert.rejects(discoverCodex(500), /could not start/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  await assert.rejects(discoverCodex(80), /timed out/);
  setEnv(t, "AUTOPROJECT_AGY_PATH", executable);
  await assert.rejects(discoverGemini(80), /failed/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("not-json");setInterval(() => {}, 1000);\n');
  await assert.rejects(discoverCodex(500), /Invalid/);
});

test("an unwritable cache preserves successful discovery in memory", async (t) => {
  const dir = fixture(t);
  const parent = path.join(dir, "not-a-directory");
  fs.writeFileSync(parent, "occupied");
  let fail = false;
  const cache = createModelCatalog({ file: () => path.join(parent, "catalog.json"), discover: async (p) => {
    if (p !== "codex" || fail) throw new Error("offline");
    return [sol];
  } });
  await cache.refresh();
  fail = true;
  await cache.refresh(true);
  assert.equal(cache.read().providers.codex.source, "cached");
  assert.deepEqual(cache.read().providers.codex.models, [sol]);
  assert.equal(fs.readFileSync(parent, "utf8"), "occupied");
});
