import * as models from "../models";
import { resumableSession as resume } from "../agent-session";
import { knownModels, modelCatalog } from "./model-catalog";

export const serverModels = () => knownModels(modelCatalog.read());
export const providerForModel = (model: string) => models.providerForModel(model, serverModels());
export const reasoningEffortsForModel = (model: string) => models.reasoningEffortsForModel(model, serverModels());
export const resolveReasoningEffort = (model: string, effort?: unknown) => models.resolveReasoningEffort(model, effort, serverModels());
export const resumableSession = (sessionId: string | undefined, model: string) => resume(sessionId, model, serverModels());
export function reasoningModel(model: string, effort?: unknown): string {
  const catalog = serverModels();
  const resolved = models.resolveReasoningEffort(model, effort, catalog);
  return (resolved && models.modelChoice(model, catalog)?.reasoningModels?.[resolved]) || model;
}
