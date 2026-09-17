export type ModelProvider = "claude" | "codex" | "gemini";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
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
}

/** Model used when the user hasn't picked one. Shared by the server-side config
 * reader and the client-side Settings modal, so both agree on the default. */
export const DEFAULT_MODEL = "claude-fable-5-1";

/** Models exposed by the locally authenticated coding-agent CLIs. */
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
  },
  {
    value: "gemini-3.1-pro-high",
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    reasoningEfforts: ["low", "high"],
  },
] as const;

/** Verified against Claude's effort docs, Codex's model catalog, and `agy models`.
 * Gemini IDs may already pin an effort; settings control that suffix at launch.
 * Unknown models keep their CLI defaults until their capabilities are known. */
export function reasoningEffortsForModel(model: string): readonly ReasoningEffort[] {
  const canonical = model.startsWith("gemini-")
    ? `${model.replace(/-(low|medium|high)$/, "")}-high`
    : model;
  return MODEL_CHOICES.find((choice) => choice.value === canonical)?.reasoningEfforts ?? [];
}

/** Old configs and unsupported selections (including model switches) use High. */
export function resolveReasoningEffort(model: string, effort?: unknown): ReasoningEffort | undefined {
  const supported = reasoningEffortsForModel(model);
  return supported.find((level) => level === effort)
    ?? supported.find((level) => level === DEFAULT_REASONING_EFFORT);
}

/** Claude and Gemini model IDs are dispatched to their CLIs. Other configured
 * model IDs are sent through Codex so a user can add a newer Codex model to
 * ~/.autoproject/config.json before this list catches up. */
export function providerForModel(model: string): ModelProvider {
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gemini-") || model.startsWith("gemini")) return "gemini";
  return "codex";
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
