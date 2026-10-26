import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MODEL_CHOICES, REASONING_LABELS, type ModelChoice, type ModelProvider } from "../models";

export const MODEL_CACHE_TTL_MS = 5 * 60_000;
const PROVIDERS: ModelProvider[] = ["claude", "codex", "gemini"];
export interface ProviderCatalog {
  models: ModelChoice[];
  source: "discovered" | "cached" | "bundled";
  lastSuccessAt?: number;
  error?: string;
}
export interface ModelCatalog {
  version: 1;
  checkedAt?: number;
  providers: Record<ModelProvider, ProviderCatalog>;
  /** Historical IDs keep saved selections routable after catalog changes. */
  retained: ModelChoice[];
}

function validModels(value: unknown, provider?: ModelProvider): value is ModelChoice[] {
  return Array.isArray(value) && value.length <= 2000 && value.every((m) => m
    && typeof m.value === "string" && m.value.length > 0 && m.value.length < 256
    && typeof m.label === "string" && m.label.length < 1024
    && PROVIDERS.includes(m.provider) && (!provider || m.provider === provider)
    && Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.every((e: string) => Object.hasOwn(REASONING_LABELS, e))
    && (m.defaultReasoningEffort === undefined || m.reasoningEfforts.includes(m.defaultReasoningEffort))
    && (m.reasoningModels === undefined || (m.reasoningModels && typeof m.reasoningModels === "object"
      && Object.entries(m.reasoningModels).every(([e, id]) => m.reasoningEfforts.includes(e) && typeof id === "string" && id.length < 256))));
}

function defaults(): ModelCatalog {
  return { version: 1, retained: [], providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    models: MODEL_CHOICES.filter((m) => m.provider === provider), source: "bundled",
  }])) as ModelCatalog["providers"] };
}

export function catalogModels(catalog: ModelCatalog): ModelChoice[] {
  return PROVIDERS.flatMap((p) => catalog.providers[p].models);
}

export function knownModels(catalog: ModelCatalog): ModelChoice[] {
  // Current capabilities override historical and bundled metadata, including [].
  return [...new Map([...MODEL_CHOICES, ...catalog.retained, ...catalogModels(catalog)].map((m) => [m.value, m])).values()];
}

/** Disk snapshots also share discovery with Next route workers and restarts.
 * Automatic attempts (including failures) are bounded by the TTL. */
export function createModelCatalog(options: {
  file: () => string;
  discover: (provider: ModelProvider) => Promise<ModelChoice[]>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let memory: ModelCatalog | undefined;
  let inFlight: Promise<ModelCatalog> | undefined;
  function read(): ModelCatalog {
    try {
      const value = JSON.parse(fs.readFileSync(options.file(), "utf8"));
      if (value.version !== 1 || !validModels(value.retained)
        || (value.checkedAt !== undefined && !Number.isFinite(value.checkedAt))
        || !PROVIDERS.every((p) => {
          const entry = value.providers?.[p];
          return entry && validModels(entry.models, p) && ["bundled", "cached", "discovered"].includes(entry.source)
            && (entry.lastSuccessAt === undefined || Number.isFinite(entry.lastSuccessAt));
        })) throw new Error("Invalid catalog cache");
      if (!memory || (value.checkedAt ?? 0) > (memory.checkedAt ?? 0)) memory = value;
    } catch { /* Missing/corrupt/unwritable cache never prevents running agents. */ }
    return memory ?? defaults();
  }
  function write(value: ModelCatalog) {
    memory = value;
    const file = options.file();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } catch { /* Keep the successful in-memory catalog if disk is unavailable. */ }
    finally { try { fs.rmSync(temporary, { force: true }); } catch { /* read-only disk */ } }
  }
  function refresh(force = false): Promise<ModelCatalog> {
    if (inFlight) return inFlight;
    const previous = read();
    const age = now() - (previous.checkedAt ?? 0);
    if (!force && previous.checkedAt !== undefined && age >= 0 && age < MODEL_CACHE_TTL_MS) return Promise.resolve(previous);
    inFlight = (async () => {
      const results = await Promise.allSettled(PROVIDERS.map(async (provider) => {
        const models = await options.discover(provider);
        if (!validModels(models, provider) || !models.length) throw new Error("Empty or invalid catalog");
        return [...new Map(models.map((m) => [m.value, m])).values()];
      }));
      const providers = { ...previous.providers };
      results.forEach((result, i) => {
        const provider = PROVIDERS[i];
        providers[provider] = result.status === "fulfilled"
          ? { models: result.value, source: "discovered", lastSuccessAt: now() }
          : { ...previous.providers[provider], source: previous.providers[provider].lastSuccessAt !== undefined ? "cached" : "bundled",
            error: "Discovery unavailable; using the last successful catalog or bundled defaults." };
      });
      const value: ModelCatalog = { version: 1, providers, checkedAt: now(),
        retained: knownModels(previous).slice(-2000) };
      write(value);
      return value;
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { read, refresh };
}

// Next may evaluate server modules in more than one route bundle. Share the
// in-flight refresh and memory fallback across those bundles and dev reloads.
const globalCatalog = globalThis as typeof globalThis & {
  autoProjectModelCatalog?: ReturnType<typeof createModelCatalog>;
};
export const modelCatalog = globalCatalog.autoProjectModelCatalog ??= createModelCatalog({
  file: () => path.join(os.homedir(), ".autoproject", "model-catalog.json"),
  discover: async (provider) => (await import("./model-discovery")).discoverers[provider](),
});
