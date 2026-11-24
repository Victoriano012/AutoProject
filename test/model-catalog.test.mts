import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelCatalog, catalogModels, knownModels } from "../lib/server/model-catalog.ts";
import { DiscoveryError } from "../lib/server/discovery-error.ts";
import { parseCodexModels, parseClaudeModels, parseGeminiModels, discoverCodex, discoverGemini, updateCodex, type Discovery } from "../lib/server/model-discovery.ts";
import { holdCodex } from "../lib/server/codex.ts";
import { latestPerFamily, modelChoice, MODEL_CHOICES, offeredModels, normalizeModelLabel, providerForModel, reasoningEffortsForModel, resolveReasoningEffort, withSelectedModel, type ModelChoice } from "../lib/models.ts";

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

test("Claude aliases are kept, and the ID an alias points at is not listed again", () => {
  const models = parseClaudeModels([
    { value: "sonnet", resolvedModel: "claude-new-sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["low", "high"] },
    { value: "claude-new-sonnet", displayName: "Sonnet", description: "" },
    { value: "unknown", displayName: "Unknown", description: "" },
    { value: "disabled", displayName: "Disabled", description: "", supportsEffort: false, supportedEffortLevels: ["high"] },
  ]);
  // "sonnet" always means the newest Sonnet, so saving it follows each release.
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
  // What the SDK lists today: aliases plus every pinned release back to 4.5,
  // each spelling its version differently. Only the newest of each survives.
  const row = (value: string, version: string, resolvedModel?: string) =>
    ({ value, resolvedModel, displayName: version.split(" ")[0], description: `${version} \u00b7 x` });
  const sdk = parseClaudeModels([
    row("opus", "Opus 5.5", "claude-opus-5-5"), row("claude-opus-5-5", "Opus 5.5"), row("claude-opus-5", "Opus 5"),
    row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"), row("claude-sonnet-5", "Sonnet 5"), row("claude-sonnet-4-6", "Sonnet 4.6"),
    row("fable", "Fable 5.2", "claude-fable-5-2"), row("claude-fable-5-1", "Fable 5.1"), row("claude-fable-5", "Fable 5"),
    row("haiku", "Haiku 5.5", "claude-haiku-5-5"), row("claude-haiku-4-5-20251001", "Haiku 4.5"), row("claude-opus-4-8", "Opus 4.8"),
  ] as never);
  assert.deepEqual(latestPerFamily(sdk).map((m) => m.label), ["Opus 5.5", "Sonnet 5.5", "Fable 5.2", "Haiku 5.5"]);
  // Versions compare as numbers, part by part: 6 < 6.2 and 6.9 < 6.10. The
  // same family name under two providers is two families.
  const tricky: ModelChoice[] = [
    { value: "gpt-6-astra", label: "Astra 6", provider: "codex", reasoningEfforts: [] },
    { value: "gpt-6.2-astra", label: "Astra 6.2", provider: "codex", reasoningEfforts: [] },
    { value: "gpt-6.9-sol", label: "Sol 6.9", provider: "codex", reasoningEfforts: [] },
    { value: "gpt-6.10-sol", label: "Sol 6.10", provider: "codex", reasoningEfforts: [] },
    { value: "gemini-6-sol-high", label: "Sol 6", provider: "gemini", reasoningEfforts: [] },
  ];
  assert.deepEqual(latestPerFamily(tricky).map((m) => m.value), ["gpt-6.2-astra", "gpt-6.10-sol", "gemini-6-sol-high"]);
  // Names the label pass cannot tidy still meet their family: any case, a
  // version anywhere, a date or build stamp, a vendor word and nothing else.
  const odd = parseCodexModels([
    { model: "gpt-6.2", displayName: "GPT-6.2" }, { model: "gpt-6.1", displayName: "GPT-6.1" }, { model: "gpt-6", displayName: "gpt-6" },
    { model: "gpt-6.1-sol-1029", displayName: "GPT-6.1-Sol-1029" }, { model: "gpt-6.2-sol", displayName: "Sol 6.2" },
    { model: "gpt-6.1-sol-2025-10-29", displayName: "GPT-6.1-Sol-2025-10-29" },
    { model: "codex-max-6.2", displayName: "Codex Max 6.2" }, { model: "codex-max-6.1", displayName: "codex max 6.1" },
    { model: "gpt-6.3-codex-max-0102", displayName: "gpt-6.3-codex-max-0102" },
  ]);
  assert.deepEqual(latestPerFamily(odd).map((m) => m.value), ["gpt-6.2", "gpt-6.2-sol", "gpt-6.3-codex-max-0102"]);
  const haiku = parseClaudeModels([
    { value: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5-20251001", description: "" },
    { value: "haiku", displayName: "Haiku 5.5", description: "" },
  ]);
  assert.deepEqual(latestPerFamily(haiku).map((m) => m.value), ["haiku"]);
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

test("every agy reasoning variant folds into one entry, including ones added later", () => {
  // `agy models` on 2026-11-24 (agy 1.5.16), plus a model that is only named Ultra.
  const [hydrogen, ...rest] = parseGeminiModels(AGY_OUTPUT + "gemini-4-ultra\tGemini 4 Ultra\n");
  assert.equal(hydrogen.label, "Hydrogen 4");
  assert.equal(hydrogen.value, "gemini-4-hydrogen-high");
  assert.deepEqual(hydrogen.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(hydrogen.reasoningModels?.xhigh, "gemini-4-hydrogen-xhigh");
  assert.deepEqual(rest.map((m) => [m.value, m.label, m.reasoningEfforts.length]), [
    ["gemini-3.8-flash-high", "Flash 3.8", 3], ["gemini-4-ultra", "Ultra 4", 0]]);
});

test("no Gemini Flash variant is offered, from discovery or the bundled fallback", () => {
  const gemini = parseGeminiModels([
    "gemini-3.9-flash-high\tGemini 3.9 Flash (High)", "gemini-3.9-flash-lite-high\tGemini 3.9 Flash-Lite (High)",
    "gemini-3.9-flash-image\tGemini 3.9 Flash Image", "gemini-4-pro-high\tGemini 4 Pro (High)",
  ].join("\n"));
  assert.deepEqual(offeredModels(gemini).map((m) => m.label), ["Pro 4"]);
  // What Settings shows before, or without, an answer from the server.
  assert.ok(MODEL_CHOICES.some((m) => /Flash/.test(m.label)));
  assert.deepEqual(offeredModels(MODEL_CHOICES).filter((m) => m.provider === "gemini").map((m) => m.label), ["Pro 3.1"]);
});

test("a stale cache's standalone xhigh entry cannot hide the folded entry's levels", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "catalog.json");
  const hydrogen = parseGeminiModels(AGY_OUTPUT)[0];
  // Shaped like ~/.autoproject/model-catalog.json on 2026-11-24: the old parser
  // stored -xhigh as a model of its own, and the history still has it.
  const stale = { value: "gemini-4-hydrogen-xhigh", label: "Hydrogen 4", provider: "gemini", reasoningEfforts: [] };
  fs.writeFileSync(file, JSON.stringify({ version: 1, checkedAt: 1, retained: [hydrogen, stale], providers: {
    claude: { models: [], source: "bundled" }, codex: { models: [], source: "bundled" },
    gemini: { models: [hydrogen], source: "discovered", lastSuccessAt: 1 } } }));
  const catalog = createModelCatalog({ file: () => file, discover: async () => ({ models: [] }) }).read();
  const known = knownModels(catalog);
  assert.ok(known.some((m) => m.value === stale.value), "the stale entry is really there");
  assert.equal(modelChoice(stale.value, known)?.value, "gemini-4-hydrogen-high");
  assert.deepEqual(reasoningEffortsForModel(stale.value, known), ["low", "medium", "high", "xhigh"]);
  assert.equal(resolveReasoningEffort(stale.value, undefined, known), "xhigh");
  const saved = withSelectedModel(catalogModels(catalog), stale.value, known).at(-1);
  assert.deepEqual([saved?.value, saved?.reasoningEfforts], [stale.value, ["low", "medium", "high", "xhigh"]]);
});

test("reads never discover, refreshes always do and coalesce, and partial successes persist", async (t) => {
  const dir = fixture(t);
  const file = () => path.join(dir, "catalog.json");
  let now = 1000;
  let calls = 0;
  let fail = false;
  const discover = async (provider: string): Promise<Discovery> => {
    calls++;
    if (provider !== "codex" || fail) throw new Error("private diagnostic must not escape");
    return { models: [sol], version: "0.172.0" };
  };
  const cache = createModelCatalog({ file, now: () => now, discover });
  // Opening Settings reads; a read must never spawn a CLI, at any cache age.
  assert.equal(cache.read().providers.codex.source, "bundled");
  assert.equal(calls, 0);
  const [first, duplicate] = await Promise.all([cache.refresh(), cache.refresh()]);
  assert.deepEqual(first, duplicate);
  assert.equal(calls, 3, "concurrent refreshes share one attempt");
  assert.equal(first.providers.codex.source, "discovered");
  assert.equal(first.providers.codex.version, "0.172.0");
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
  // The list is still the one 0.172.0 fetched, so it still says so.
  assert.equal(stale.providers.codex.version, "0.172.0");
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
    return { models: choices };
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
    return { models: [{ value: "gpt-6-astra", label: "Astra", provider: "codex", reasoningEfforts: [] }] };
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
  if (req.method === 'initialize') console.log(JSON.stringify({id:req.id,result:{userAgent:'autoproject/0.172.0 (Mac OS 26.6.0; arm64)'}}));
  if (req.method === 'model/list') console.log(JSON.stringify({ id:req.id,result:{data:[{model:req.params.cursor ? 'gpt-next' : 'gpt-6.1-sol', supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:req.params.cursor ? null : 'page2'}}));
});
`, { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  const { models, version } = await discoverCodex(2000);
  assert.deepEqual(models.map((m) => m.value), ["gpt-6.1-sol", "gpt-next"]);
  // Codex only offers its newest models to a recent enough CLI, so the version
  // that answered is the difference between "nothing new" and "nothing newer".
  assert.equal(version, "0.172.0");
  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((m) => m.method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.equal(messages[3].params.cursor, "page2");
});

test("Gemini discovery reports the agy that answered, and survives it not saying", async (t) => {
  const dir = fixture(t);
  const executable = path.join(dir, "agy");
  fs.writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('1.5.16'); process.exit(0); }
console.log('Fetching available models...');
console.log('gemini-4-pro-high\tGemini 4 Pro (High)');
`, { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_AGY_PATH", executable);
  const found = await discoverGemini(5000);
  assert.deepEqual(found.models.map((m) => m.value), ["gemini-4-pro-high"]);
  assert.equal(found.version, "1.5.16");
  // A tool that will not name itself still gets its models listed.
  fs.writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') process.exit(1);
console.log('gemini-4-pro-high\tGemini 4 Pro (High)');
`, { mode: 0o700 });
  const quiet = await discoverGemini(5000);
  assert.deepEqual(quiet.models.map((m) => m.value), ["gemini-4-pro-high"]);
  assert.equal(quiet.version, undefined);
});

test("CLI discovery is bounded and rejects missing tools and malformed responses", async (t) => {
  const dir = fixture(t);
  const executable = path.join(dir, "fake-tool");
  // The 80ms cases below assert the bound; these assert the rejection reason, so
  // they get room for process start-up when the whole suite runs in parallel.
  setEnv(t, "AUTOPROJECT_CODEX_PATH", path.join(dir, "missing"));
  await assert.rejects(discoverCodex(10_000), /is not installed/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  await assert.rejects(discoverCodex(80), /timed out/);
  setEnv(t, "AUTOPROJECT_AGY_PATH", executable);
  await assert.rejects(discoverGemini(80), /timed out/);
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("not-json");setInterval(() => {}, 1000);\n');
  await assert.rejects(discoverCodex(10_000), /returned an unreadable response/);
});

test("an unwritable cache preserves successful discovery in memory", async (t) => {
  const dir = fixture(t);
  const parent = path.join(dir, "not-a-directory");
  fs.writeFileSync(parent, "occupied");
  let fail = false;
  const cache = createModelCatalog({ file: () => path.join(parent, "catalog.json"), discover: async (p) => {
    if (p !== "codex" || fail) throw new Error("offline");
    return { models: [sol] };
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
  // Today's CLI names the version in displayName; free description text that
  // happens to hold a number never becomes the name.
  assert.equal(parseClaudeModels([{ value: "fable", displayName: "Fable 5.2", description: "Fable with 1M context \u00b7 x" }])[0].label, "Fable 5.2");
  // Someone already saved it: it must stay visible, selectable and Claude-routed.
  const listed = withSelectedModel(models, "default");
  assert.equal(listed.length, 2);
  assert.equal(listed.at(-1)?.value, "default");
  assert.equal(listed.at(-1)?.provider, "claude");
  assert.equal(providerForModel("default", models), "claude");
});

// Captured from the installed CLIs on 2026-11-24: codex 0.172.0, claude 2.1.331,
// agy 1.5.16. A refresh has to carry a newly released model all the way through.
const codexRow = (model: string, displayName: string, hidden = false) =>
  ({ model, displayName, hidden, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" });
const CODEX_ROWS = [
  codexRow("gpt-6.2-sol", "GPT-6.2-Sol"), codexRow("gpt-6.2-astra", "GPT-6.2-Astra"), codexRow("gpt-6.1-terra", "GPT-6.1 Terra"),
  codexRow("gpt-reserve", "GPT-Reserve", true), codexRow("gpt-6.1-sol", "GPT-6.1-Sol"), codexRow("gpt-6-astra", "GPT-6-Astra"),
  codexRow("gpt-6-sol", "GPT-6-Sol"), codexRow("gpt-6-luna", "GPT-6-Luna"), codexRow("gpt-5.6-sol", "GPT-5.6-Sol"),
  codexRow("gpt-5.6-terra", "GPT-5.6-Terra"), codexRow("gpt-5.6-luna", "GPT-5.6-Luna"),
];
const claudeRow = (value: string, displayName: string, resolvedModel = value) =>
  ({ value, resolvedModel, displayName, description: "For complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "high"] });
const CLAUDE_ROWS = [
  claudeRow("default", "Default (recommended)", "claude-opus-5-5"), claudeRow("opus", "Opus 5.5", "claude-opus-5-5"),
  claudeRow("claude-opus-5", "Opus 5"), claudeRow("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"), claudeRow("claude-sonnet-5", "Sonnet 5"),
  claudeRow("fable", "Fable 5.2", "claude-fable-5-2"), claudeRow("claude-fable-5-1", "Fable 5.1"), claudeRow("haiku", "Haiku 5.5", "claude-haiku-5-5"),
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  claudeRow("claude-fable-5", "Fable 5"), claudeRow("claude-opus-4-8", "Opus 4.8"), claudeRow("claude-opus-4-7", "Opus 4.7"),
  claudeRow("claude-opus-4-6", "Opus 4.6"), claudeRow("claude-sonnet-4-6", "Sonnet 4.6"),
];
const AGY_OUTPUT = [
  "Fetching available models...",
  "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

test("Settings offers only the newest of each family, without Flash, and a future release replaces it", async (t) => {
  const dir = fixture(t);
  let released = false;
  // The tools' raw answers: the catalog decides what Settings offers.
  const discover = async (provider: string): Promise<Discovery> => {
    if (provider === "codex") return { models: parseCodexModels([...CODEX_ROWS, ...released ? [codexRow("gpt-6.3-luna", "GPT-6.3-Luna")] : []]) };
    if (provider === "claude") return { models: parseClaudeModels((released
      // `opus` moves on to Opus 5.6, so Opus 5.5 is listed by its own ID again.
      ? [claudeRow("opus", "Opus 5.6", "claude-opus-5-6"), claudeRow("claude-opus-5-5", "Opus 5.5"), ...CLAUDE_ROWS.slice(2)]
      : CLAUDE_ROWS) as never) };
    return { models: parseGeminiModels(AGY_OUTPUT + (released
      ? "gemini-4.1-hydrogen-high\tGemini 4.1 Hydrogen (High)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.9-flash-high\tGemini 3.9 Flash (High)\n"
      : "")) };
  };
  const cache = createModelCatalog({ file: () => path.join(dir, "catalog.json"), discover });
  const shown = async () => {
    const catalog = await cache.refresh();
    return withSelectedModel(catalogModels(catalog), "claude-opus-5", knownModels(catalog)).map((m) => `${m.value}=${m.label}`);
  };
  assert.deepEqual(await shown(), [
    "opus=Opus 5.5", "sonnet=Sonnet 5.5", "fable=Fable 5.2", "haiku=Haiku 5.5",
    "gpt-6.2-sol=Sol 6.2", "gpt-6.2-astra=Astra 6.2", "gpt-6.1-terra=Terra 6.1", "gpt-6-luna=Luna 6",
    "gemini-4-hydrogen-high=Hydrogen 4",
    "claude-opus-5=Opus 5 (saved selection)",
  ]);
  released = true;
  assert.deepEqual(await shown(), [
    "opus=Opus 5.6", "sonnet=Sonnet 5.5", "fable=Fable 5.2", "haiku=Haiku 5.5",
    "gpt-6.2-sol=Sol 6.2", "gpt-6.2-astra=Astra 6.2", "gpt-6.1-terra=Terra 6.1", "gpt-6.3-luna=Luna 6.3",
    "gemini-4.1-hydrogen-high=Hydrogen 4.1", "gemini-4-argon-high=Argon 4",
    "claude-opus-5=Opus 5 (saved selection)",
  ]);
  // Flash is gone from the bundled fallback too, not just from discovery.
  assert.ok(!catalogModels(createModelCatalog({ file: () => path.join(dir, "none.json"), discover }).read()).some((m) => /Flash/.test(m.label)));
});

test("every press of Refresh asks every tool again, even after one failed", async (t) => {
  const home = fixture(t);
  t.mock.method(os, "homedir", () => home);
  const { discoverers } = await import("../lib/server/model-discovery.ts");
  const calls: Record<string, number> = {};
  for (const provider of ["claude", "codex", "gemini"] as const) {
    t.mock.method(discoverers, provider, async () => {
      calls[provider] = (calls[provider] ?? 0) + 1;
      if (provider === "codex" && calls.codex === 1) throw new DiscoveryError("timed out");
      return { models: [{ value: `${provider}-model`, label: "Model", provider, reasoningEfforts: [] }] };
    });
  }
  const { POST } = await import("../app/api/models/route.ts");
  for (let press = 1; press <= 3; press++) {
    await (await POST()).json();
    assert.deepEqual(calls, { claude: press, codex: press, gemini: press });
  }
});

/** A Codex whose `update` takes `delay` ms to install 0.172.0, saying "installing"
 * meanwhile. Before that its app-server dies on start, and "broken" makes
 * `--version` fail too. */
function fakeCodex(t: test.TestContext, version: string, delay = 0) {
  const dir = fixture(t);
  const executable = path.join(dir, "codex");
  const state = path.join(dir, "version");
  fs.writeFileSync(state, version);
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const version = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
if (process.argv[2] === 'update') { fs.writeFileSync(${JSON.stringify(state)}, 'installing'); setTimeout(() => fs.writeFileSync(${JSON.stringify(state)}, '0.172.0'), ${delay}); }
else if (process.argv[2] === '--version') { if (version === 'broken') process.exit(1); console.log('codex-cli ' + version); }
else if (version !== '0.172.0') process.exit(1);
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') console.log(JSON.stringify({ id: req.id, result: { userAgent: 'autoproject/0.172.0 (Mac OS)' } }));
  if (req.method === 'model/list') console.log(JSON.stringify({ id: req.id, result: { data: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol' }], nextCursor: null } }));
});
`, { mode: 0o700 });
  setEnv(t, "AUTOPROJECT_CODEX_PATH", executable);
  return () => fs.readFileSync(state, "utf8");
}

test("an outdated Codex is updated even when it cannot list its models or say its version", async (t) => {
  const latest = async () => "0.172.0";
  for (const start of ["0.160.0", "broken"]) {
    const installed = fakeCodex(t, start);
    await assert.rejects(discoverCodex(5000), /stopped before answering/);
    assert.equal(await updateCodex(latest), "0.172.0");
    assert.deepEqual((await discoverCodex(5000)).models.map((m) => m.value), ["gpt-6.2-sol"]);
    assert.equal(installed(), "0.172.0");
  }
  // Already current, or npm unreachable: nothing is installed.
  assert.equal(await updateCodex(latest), undefined);
  const installed = fakeCodex(t, "0.160.0");
  assert.equal(await updateCodex(async () => { throw new Error("offline"); }), undefined);
  assert.equal(installed(), "0.160.0");
});

test("Codex is never updated under a run, and a run never starts on a half-installed one", async (t) => {
  const installed = fakeCodex(t, "0.160.0", 300);
  const latest = async () => "0.172.0";
  const release = await holdCodex();
  assert.equal(await updateCodex(latest), undefined, "a run is going: no update");
  assert.equal(installed(), "0.160.0");
  release();
  const updating = updateCodex(latest);
  while (installed() !== "installing") await new Promise((r) => setTimeout(r, 20));
  // A refresh mid-install answers at once rather than waiting for it.
  const { discoverers } = await import("../lib/server/model-discovery.ts");
  await assert.rejects(discoverers.codex(), /is updating/);
  assert.equal(installed(), "installing");
  // A run asked for mid-install starts only once the install is complete.
  const run = await holdCodex();
  run();
  assert.equal(installed(), "0.172.0");
  assert.equal(await updating, "0.172.0");
});

test("a refresh answers without waiting on a Codex update, whose models then land by themselves", async (t) => {
  const home = fixture(t);
  t.mock.method(os, "homedir", () => home);
  t.mock.method(globalThis, "fetch", async () => Response.json({ version: "0.172.0" }));
  fakeCodex(t, "0.160.0", 1500);
  const { discoverers } = await import("../lib/server/model-discovery.ts");
  for (const provider of ["claude", "gemini"] as const) {
    t.mock.method(discoverers, provider, async () => ({ models: [{ value: `${provider}-model`, label: "Model", provider, reasoningEfforts: [] }] }));
  }
  const { POST, GET } = await import("../app/api/models/route.ts");
  const started = Date.now();
  const first = await (await POST()).json();
  assert.ok(Date.now() - started < 1500, "Claude and Gemini did not wait for the install");
  assert.equal(first.providers.codex.error, "stopped before answering");
  assert.equal(first.models.find((m: ModelChoice) => m.provider === "claude")?.value, "claude-model");
  let codex: ModelChoice[] = [];
  for (let i = 0; i < 100 && !codex.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    codex = (await (await GET()).json()).models.filter((m: ModelChoice) => m.provider === "codex" && m.value === "gpt-6.2-sol");
  }
  assert.equal(codex.length, 1, "the updated Codex's models arrive without another press");
});

test("Claude runs the person's own, self-updating CLI when there is one", async (t) => {
  const { claudeExecutable } = await import("../lib/server/claude.ts");
  const dir = fixture(t);
  setEnv(t, "AUTOPROJECT_CLAUDE_PATH", "");
  setEnv(t, "PATH", dir);
  assert.equal(claudeExecutable(), undefined, "none installed: the SDK's bundled copy");
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(claudeExecutable(), path.join(dir, "claude"));
  setEnv(t, "AUTOPROJECT_CLAUDE_PATH", "/opt/claude");
  assert.equal(claudeExecutable(), "/opt/claude");
});

test("a provider that fails says which one and why, without leaking the raw error", async (t) => {
  const dir = fixture(t);
  const sol: ModelChoice = { value: "gpt-6.1-sol", label: "Sol 6.1", provider: "codex", reasoningEfforts: ["high"] };
  let fail: Record<string, () => never> = {};
  const cache = createModelCatalog({ file: () => path.join(dir, "catalog.json"), discover: async (p) => {
    fail[p]?.();
    return { models: p === "codex" ? [sol] : [] };
  } });
  // Every provider fails a different way, and each reason names the cause.
  fail = {
    codex: () => { throw new DiscoveryError("timed out"); },
    claude: () => { throw new Error("/Users/secret/.config/token-abc123 not readable"); },
    gemini: () => { throw new DiscoveryError("is not installed"); },
  };
  const failed = await cache.refresh();
  assert.equal(failed.providers.codex.error, "timed out");
  assert.equal(failed.providers.gemini.error, "is not installed");
  // A raw error may carry paths or credentials, so only our own wording shows.
  assert.equal(failed.providers.claude.error, "could not be reached");
  assert.equal(JSON.stringify(failed).includes("token-abc123"), false);
  // An empty result is a failure too, and says so rather than looking unchanged.
  fail = {};
  const empty = await cache.refresh();
  assert.equal(empty.providers.claude.error, "returned no usable models");
  assert.equal(empty.providers.codex.error, undefined);
  assert.equal(empty.providers.codex.source, "discovered");
  assert.deepEqual(empty.providers.codex.models, [sol]);
});

test("families come from the name shown, whatever the ID looks like, and one bad row stays one bad row", async (t) => {
  // Sol 2 reads as an older Sol than Sol 6.1, so it goes; a Sol with no
  // version cannot be ordered against either, so it stays.
  const codex = parseCodexModels([
    { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }, { model: "gpt-sol", displayName: "GPT-Sol" },
    { model: "gpt-sol-2", displayName: "GPT-Sol-2" }, { model: "gpt-6-sol", displayName: "GPT-6-Sol" },
  ]);
  assert.deepEqual(latestPerFamily(codex).map((m) => m.value), ["gpt-6.1-sol", "gpt-sol"]);
  // agy IDs are not limited to word characters.
  assert.deepEqual(parseGeminiModels("gemini-4-pro[1m]-high\tGemini 4 Pro 1M (High)\n").map((m) => m.value), ["gemini-4-pro[1m]-high"]);
  // Nothing recognisable left: keep the name the tool gave rather than none.
  assert.equal(normalizeModelLabel("(default)"), "(default)");
  // An unusable row is dropped by itself; the release beside it still arrives.
  const dir = fixture(t);
  const cache = createModelCatalog({ file: () => path.join(dir, "catalog.json"), discover: async (p) => ({ models: p === "codex"
    ? [{ value: "gpt-7-nova", label: "Nova 7", provider: "codex", reasoningEfforts: ["high"] },
      { value: "gpt-7-junk", label: "x".repeat(2000), provider: "codex", reasoningEfforts: ["high"] }]
    : [] }) });
  const catalog = await cache.refresh();
  assert.deepEqual(catalog.providers.codex.models.map((m) => m.value), ["gpt-7-nova"]);
  assert.equal(catalog.providers.codex.error, undefined);
});
