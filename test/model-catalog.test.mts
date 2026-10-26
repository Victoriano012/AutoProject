import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelCatalog, catalogModels, knownModels } from "../lib/server/model-catalog.ts";
import { parseCodexModels, parseClaudeModels, parseGeminiModels, discoverCodex, discoverGemini, latestPerFamily } from "../lib/server/model-discovery.ts";
import { MODEL_CHOICES, normalizeModelLabel, providerForModel, reasoningEffortsForModel, resolveReasoningEffort, withSelectedModel, type ModelChoice } from "../lib/models.ts";

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

test("Claude models are listed once under the name the tool reports", () => {
  const models = parseClaudeModels([
    { value: "sonnet", resolvedModel: "claude-new-sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["low", "high"] },
    { value: "unknown", displayName: "Unknown", description: "" },
    { value: "disabled", displayName: "Disabled", description: "", supportsEffort: false, supportedEffortLevels: ["high"] },
  ]);
  // The resolved ID is the same model under a pinned name: listing it too would
  // double the menu and leave the raw ID showing in the label.
  assert.deepEqual(models.map((m) => [m.value, m.label]), [["sonnet", "Sonnet"], ["unknown", "Unknown"], ["disabled", "Disabled"]]);
  assert.equal(providerForModel("sonnet", models), "claude");
  assert.deepEqual(reasoningEffortsForModel("sonnet", models), ["low", "high"]);
  assert.deepEqual(reasoningEffortsForModel("unknown", models), []);
  assert.deepEqual(reasoningEffortsForModel("disabled", models), []);
});

test("only the newest release of each family is offered, and a hidden one stays selectable", () => {
  const codex = parseCodexModels([
    { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }, { model: "gpt-6-astra", displayName: "GPT-6-Astra" },
    { model: "gpt-6-sol", displayName: "GPT-6-Sol" }, { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
    { model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
  ]);
  // Superseded releases drop out; Terra has no newer release, so it stays.
  assert.deepEqual(latestPerFamily(codex).map((m) => [m.value, m.label]),
    [["gpt-6.1-sol", "Sol 6.1"], ["gpt-6-astra", "Astra 6"], ["gpt-5.6-terra", "Terra 5.6"]]);
  // Unversioned aliases are each their own family, so none of them collapse.
  const claude = parseClaudeModels([
    { value: "opus", displayName: "Opus", description: "" }, { value: "sonnet", displayName: "Sonnet", description: "" },
    { value: "haiku", displayName: "Haiku", description: "" },
  ]);
  assert.deepEqual(latestPerFamily(claude).map((m) => m.value), ["opus", "sonnet", "haiku"]);
  // A superseded model someone already picked must remain visible and routable.
  const listed = withSelectedModel(latestPerFamily(codex), "gpt-5.6-sol", codex);
  assert.deepEqual(listed.at(-1), { value: "gpt-5.6-sol", label: "Sol 5.6 (saved selection)", provider: "codex", reasoningEfforts: [], defaultReasoningEffort: undefined });
});

test("Gemini offers only listed variants and ignores other providers and progress text", () => {
  const models = parseGeminiModels("Fetching available models...\ngemini-new-high\tGemini New (High)\ngemini-new-low\tGemini New (Low)\nclaude-other\tOther\ngpt-oss-medium\tOther\ngemini-unknown\tUnknown\n");
  assert.equal(models.length, 2);
  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  assert.deepEqual(models[0].reasoningModels, { low: "gemini-new-low", high: "gemini-new-high" });
  assert.deepEqual(models[1].reasoningEfforts, []);
  assert.equal(resolveReasoningEffort("gemini-new-high", "medium", models), "high");
});

test("reads never discover, refreshes always do and coalesce, and partial successes persist", async (t) => {
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
  // Opening Settings reads; a read must never spawn a CLI, at any cache age.
  assert.equal(cache.read().providers.codex.source, "bundled");
  assert.equal(calls, 0);
  const [first, duplicate] = await Promise.all([cache.refresh(), cache.refresh()]);
  assert.deepEqual(first, duplicate);
  assert.equal(calls, 3, "concurrent refreshes share one attempt");
  assert.equal(first.providers.codex.source, "discovered");
  assert.equal(first.providers.claude.source, "bundled");
  assert.equal(JSON.stringify(first).includes("private diagnostic"), false);
  // However fresh the catalog, a read is free and a refresh still discovers.
  cache.read();
  assert.equal(calls, 3);
  await cache.refresh();
  assert.equal(calls, 6, "a refresh is never skipped as too recent");
  now++;
  fail = true;
  const stale = await cache.refresh();
  assert.equal(calls, 9);
  assert.equal(stale.providers.codex.source, "cached");
  assert.deepEqual(stale.providers.codex.models, [sol]);
  const restarted = createModelCatalog({ file, now: () => now, discover });
  assert.deepEqual(restarted.read().providers.codex.models, [sol]);
  assert.equal(calls, 9, "disk snapshots survive restart without discovering");
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
  const latest = await cache.refresh();
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
  // The 80ms cases below assert the bound; these assert the rejection reason, so
  // they get room for process start-up when the whole suite runs in parallel.
  setEnv(t, "AUTOPROJECT_CODEX_PATH", path.join(dir, "missing"));
  await assert.rejects(discoverCodex(10_000), /could not start/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  await assert.rejects(discoverCodex(80), /timed out/);
  setEnv(t, "AUTOPROJECT_AGY_PATH", executable);
  await assert.rejects(discoverGemini(80), /failed/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("not-json");setInterval(() => {}, 1000);\n');
  await assert.rejects(discoverCodex(10_000), /Invalid/);
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
  await cache.refresh();
  assert.equal(cache.read().providers.codex.source, "cached");
  assert.deepEqual(cache.read().providers.codex.models, [sol]);
  assert.equal(fs.readFileSync(parent, "utf8"), "occupied");
});

test("every provider's spelling collapses to family then version", () => {
  // The exact strings each CLI hands us today.
  assert.equal(normalizeModelLabel("GPT-6.1-Sol"), "Sol 6.1");
  assert.equal(normalizeModelLabel("GPT-6-Astra"), "Astra 6");
  assert.equal(normalizeModelLabel("Gemini 3.8 Flash (High)"), "Flash 3.8");
  assert.equal(normalizeModelLabel("Gemini 3.1 Pro"), "Pro 3.1");
  assert.equal(normalizeModelLabel("Default (recommended)"), "Default");
  assert.equal(normalizeModelLabel("Fable 5.1 (default)"), "Fable 5.1");
  assert.equal(normalizeModelLabel("Claude Opus 5.5"), "Opus 5.5");
  assert.equal(normalizeModelLabel("Haiku 4.5"), "Haiku 4.5");
  // Shapes we cannot read are passed through rather than mangled.
  for (const odd of ["Opus", "claude-haiku-4-5-20251001", "GPT-5.6", "o3"]) {
    assert.equal(normalizeModelLabel(odd), odd);
  }
  // Bundled entries are normalised by the same pass as discovered ones.
  assert.equal(MODEL_CHOICES.find((m) => m.value === "gpt-6-astra")?.label, "Astra 6");
  assert.ok(!MODEL_CHOICES.some((m) => /default|recommended/i.test(m.label)));
});

test("Claude's Default alias is not a model, and picking it still resolves", () => {
  const models = parseClaudeModels([
    { value: "default", resolvedModel: "claude-opus-5", displayName: "Default (recommended)", description: "", supportedEffortLevels: ["low", "high"] },
    // The SDK carries the version in the description, not the display name.
    { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "Opus 5.5 \u00b7 Best for everyday, complex tasks", supportedEffortLevels: ["low", "high"] },
  ]);
  assert.deepEqual(models.map((m) => [m.value, m.label]), [["opus", "Opus 5.5"]]);
  // Someone already saved it: it must stay visible, selectable and Claude-routed.
  const listed = withSelectedModel(models, "default");
  assert.equal(listed.length, 2);
  assert.equal(listed.at(-1)?.value, "default");
  assert.equal(listed.at(-1)?.provider, "claude");
  assert.equal(providerForModel("default", models), "claude");
});
