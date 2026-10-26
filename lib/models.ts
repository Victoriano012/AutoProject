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

/** Model used when the user hasn't picked one. Shared by the server-side config
 * reader and the client-side Settings modal, so both agree on the default. */
export const DEFAULT_MODEL = "claude-fable-5-1";

/** Bundled fallback used until local agent discovery succeeds. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
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
] as const;

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

/** Explicit discovery metadata takes precedence over legacy ID conventions. */
export function providerForModel(model: string, catalog: readonly ModelChoice[] = MODEL_CHOICES): ModelProvider {
  const known = modelChoice(model, catalog);
  if (known) return known.provider;
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gemini")) return "gemini";
  return "codex";
}

/** A missing saved or in-progress selection must remain visible and selectable. */
export function withSelectedModel(catalog: readonly ModelChoice[], selected: string, previous: readonly ModelChoice[] = MODEL_CHOICES): readonly ModelChoice[] {
  if (catalog.some((choice) => choice.value === selected)) return catalog;
  const known = modelChoice(selected, previous);
  return [...catalog, {
    ...known,
    value: selected,
    label: `${known?.label ?? selected} (saved selection)`,
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
