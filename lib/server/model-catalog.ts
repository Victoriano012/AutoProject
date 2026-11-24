import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DiscoveryError, discoveryReason } from "./discovery-error";
import type { Discovery } from "./model-discovery";
import { MODEL_CHOICES, offeredModels, REASONING_LABELS, type ModelChoice, type ModelProvider } from "../models";

const PROVIDERS: ModelProvider[] = ["claude", "codex", "gemini"];
export interface ProviderCatalog {
  models: ModelChoice[];
  source: "discovered" | "cached" | "bundled";
  lastSuccessAt?: number;
  error?: string;
  /** Version of the tool that answered: it decides which models exist. */
  version?: string;
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

const reported = (catalog: ModelCatalog) => PROVIDERS.flatMap((p) => catalog.providers[p].models);

/** What Settings offers. The cache keeps everything the tools reported, so the
 * rule applies to old snapshots too; hidden models still run via `knownModels`. */
export const catalogModels = (catalog: ModelCatalog): ModelChoice[] => offeredModels(reported(catalog));

export function knownModels(catalog: ModelCatalog): ModelChoice[] {
  // Current capabilities override historical and bundled metadata, including [].
  return [...new Map([...MODEL_CHOICES, ...catalog.retained, ...reported(catalog)].map((m) => [m.value, m])).values()];
}

/** Disk snapshots also share discovery with Next route workers and restarts.
 * Nothing here discovers on its own: `read` is the only path the app takes
 * unless someone asks for a refresh. */
export function createModelCatalog(options: {
  file: () => string;
  discover: (provider: ModelProvider) => Promise<Discovery>;
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
            && (entry.lastSuccessAt === undefined || Number.isFinite(entry.lastSuccessAt))
            && (entry.version === undefined || (typeof entry.version === "string" && entry.version.length < 64));
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
  /** Always discovers. Concurrent callers share the one in-flight attempt. */
  function refresh(): Promise<ModelCatalog> {
    if (inFlight) return inFlight;
    const previous = read();
    inFlight = (async () => {
      const results = await Promise.allSettled(PROVIDERS.map(async (provider) => {
        const found = await options.discover(provider);
        // Per model, not per provider: one oddly shaped new release must not
        // take the whole list down with it.
        const models = found.models.filter((m) => validModels([m], provider));
        if (!models.length) throw new DiscoveryError("returned no usable models");
        return { models: [...new Map(models.map((m) => [m.value, m])).values()], version: found.version };
      }));
      const providers = { ...previous.providers };
      results.forEach((result, i) => {
        const provider = PROVIDERS[i];
        providers[provider] = result.status === "fulfilled"
          ? { models: result.value.models, source: "discovered", lastSuccessAt: now(), version: result.value.version }
          // Why, not just that: an unchanged list is otherwise indistinguishable
          // from a refresh that found nothing new.
          : { ...previous.providers[provider], source: previous.providers[provider].lastSuccessAt !== undefined ? "cached" : "bundled",
            error: discoveryReason(result.reason) };
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

// Not pinned on globalThis: a pinned instance kept running the discovery code
// it was created with, so a dev server never picked up a fix. The disk file is
// what route bundles share.
export const modelCatalog = createModelCatalog({
  file: () => path.join(os.homedir(), ".autoproject", "model-catalog.json"),
  discover: async (provider) => (await import("./model-discovery")).discoverers[provider](),
});
