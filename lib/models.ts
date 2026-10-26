export type ModelProvider = "claude" | "codex" | "gemini";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const ULTRA_EFFORTS = [...STANDARD_EFFORTS, "ultra"] as const;

export interface ModelChoice {
  value: string;
  label: string;
  provider: ModelProvider;
  reasoningEfforts: readonly ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  /** Exact CLI IDs, when reasoning is selected through model variants (agy). */
  reasoningModels?: Partial<Record<ReasoningEffort, string>>;
}

const LABEL_NOISE = /\s*\((?:default|recommended|none|minimal|low|medium|high|extra high|xhigh|max|ultra)\)$/i;
const VENDORS = new Set(["claude", "anthropic", "gpt", "openai", "gemini", "google"]);
const VERSION_WORD = /^\d+(?:\.\d+)*$/;

/** Every CLI spells its models differently — "GPT-6.1-Sol", "Gemini 3.8 Flash
 * (High)", "Fable 5.1 (default)" — so the dropdown reads as three vocabularies
 * at once. Reduce them all to family then version, dropping the vendor word
 * that the provider group above the dropdown already says. A name that does not
 * fit that shape is passed through untouched: an odd name beats a wrong one. */
export function normalizeModelLabel(label: string): string {
  let name = label.trim();
  while (LABEL_NOISE.test(name)) name = name.replace(LABEL_NOISE, "").trim();
  const words = name.split(/[\s-]+/).filter(Boolean);
  if (words.length && VENDORS.has(words[0].toLowerCase())) words.shift();
  const versions = words.filter((word) => VERSION_WORD.test(word));
  const family = words.filter((word) => !VERSION_WORD.test(word));
  // No version, several, or nothing left beside one: not a shape we know.
  return versions.length === 1 && family.length > 0 ? `${family.join(" ")} ${versions[0]}` : name;
}

export function normalizeChoice<T extends ModelChoice>(choice: T): T {
  return { ...choice, label: normalizeModelLabel(choice.label) };
}

/** Model used when the user hasn't picked one. Shared by the server-side config
 * reader and the client-side Settings modal, so both agree on the default. */
export const DEFAULT_MODEL = "claude-fable-5-1";

const BUNDLED: readonly ModelChoice[] = [
  { value: DEFAULT_MODEL, label: "Fable 5.1 (default)", provider: "claude", reasoningEfforts: STANDARD_EFFORTS },
  { value: "claude-opus-5", label: "Opus 5", provider: "claude", reasoningEfforts: STANDARD_EFFORTS },
  { value: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", reasoningEfforts: STANDARD_EFFORTS },
  {
    value: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    provider: "claude",
    reasoningEfforts: [],
  },
  { value: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex", reasoningEfforts: ULTRA_EFFORTS },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex", reasoningEfforts: ULTRA_EFFORTS },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex", reasoningEfforts: ULTRA_EFFORTS },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex", reasoningEfforts: STANDARD_EFFORTS },
  {
    value: "gemini-3.7-flash-high",
    label: "Gemini 3.7 Flash",
    provider: "gemini",
    reasoningEfforts: ["low", "medium", "high"],
    reasoningModels: { low: "gemini-3.7-flash-low", medium: "gemini-3.7-flash-medium", high: "gemini-3.7-flash-high" },
  },
  {
    value: "gemini-3.1-pro-high",
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    reasoningEfforts: ["low", "high"],
    reasoningModels: { low: "gemini-3.1-pro-low", high: "gemini-3.1-pro-high" },
  },
];

/** Bundled fallback used until local agent discovery succeeds. Normalised like
 * the discovered entries so the two spellings cannot drift apart. */
export const MODEL_CHOICES: readonly ModelChoice[] = BUNDLED.map(normalizeChoice);

/** Pure catalog helpers are shared by Settings and the server integrations. */
export function modelChoice(model: string, catalog: readonly ModelChoice[] = MODEL_CHOICES): ModelChoice | undefined {
  return catalog.find((choice) => choice.value === model)
    ?? catalog.find((choice) => Object.values(choice.reasoningModels ?? {}).includes(model))
    ?? (model.startsWith("gemini-") && !/-(low|medium|high)$/.test(model)
      ? catalog.find((choice) => choice.value === `${model.replace(/-(low|medium|high)$/, "")}-high`)
      : undefined);
}

export function reasoningEffortsForModel(model: string, catalog: readonly ModelChoice[] = MODEL_CHOICES): readonly ReasoningEffort[] {
  return modelChoice(model, catalog)?.reasoningEfforts ?? [];
}

export function resolveReasoningEffort(model: string, effort?: unknown, catalog: readonly ModelChoice[] = MODEL_CHOICES): ReasoningEffort | undefined {
  const choice = modelChoice(model, catalog);
  const supported = choice?.reasoningEfforts ?? [];
  return supported.find((level) => level === effort)
    ?? supported.find((level) => level === DEFAULT_REASONING_EFFORT)
    ?? supported.find((level) => level === choice?.defaultReasoningEffort);
}

/** Claude's CLI aliases carry no provider prefix, so a saved `opus` would fall
 * through to the Codex branch whenever the catalog is unavailable. */
const CLAUDE_ALIASES = new Set(["default", "opus", "opusplan", "sonnet", "haiku", "fable"]);

/** Explicit discovery metadata takes precedence over legacy ID conventions. */
export function providerForModel(model: string, catalog: readonly ModelChoice[] = MODEL_CHOICES): ModelProvider {
  const known = modelChoice(model, catalog);
  if (known) return known.provider;
  if (model.startsWith("claude-") || CLAUDE_ALIASES.has(model)) return "claude";
  if (model.startsWith("gemini")) return "gemini";
  return "codex";
}

const SAVED_SUFFIX = " (saved selection)";

/** A missing saved or in-progress selection must remain visible and selectable.
 * `previous` may already be a labelled result, so the suffix is applied once. */
export function withSelectedModel(catalog: readonly ModelChoice[], selected: string, previous: readonly ModelChoice[] = MODEL_CHOICES): readonly ModelChoice[] {
  if (catalog.some((choice) => choice.value === selected)) return catalog;
  const known = modelChoice(selected, previous);
  const label = known?.label ?? selected;
  return [...catalog, {
    ...known,
    value: selected,
    label: label.endsWith(SAVED_SUFFIX) ? label : `${label}${SAVED_SUFFIX}`,
    provider: known?.provider ?? providerForModel(selected),
    reasoningEfforts: known?.reasoningEfforts ?? [],
  }];
}

/** Provider capabilities are independent of each model's reasoning choices.
 * Orchestration uses this catalog instead of testing provider names. */
export const PROVIDER_CAPABILITIES: Record<ModelProvider, {
  liveMessages: boolean;
  boardTools: boolean;
  structuredOutput: boolean;
  subagents: boolean;
  reportedCost: boolean;
}> = {
  claude: { liveMessages: true, boardTools: true, structuredOutput: true, subagents: true, reportedCost: true },
  codex: { liveMessages: false, boardTools: false, structuredOutput: true, subagents: false, reportedCost: false },
  gemini: { liveMessages: false, boardTools: false, structuredOutput: true, subagents: false, reportedCost: false },
};
