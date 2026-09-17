import { type AppConfig, readConfig, writeConfig } from "@/lib/config";
import { DEFAULT_MODEL, reasoningEffortsForModel, resolveReasoningEffort } from "@/lib/models";

export async function GET() {
  const config = readConfig();
  return Response.json({
    ...config,
    reasoningEffort: resolveReasoningEffort(config.model || DEFAULT_MODEL, config.reasoningEffort),
  });
}

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid settings." }, { status: 400 });
  }
  const { model, reasoningEffort } = body as AppConfig;
  if (model !== undefined && typeof model !== "string") {
    return Response.json({ error: "Invalid model." }, { status: 400 });
  }
  const current = readConfig();
  const nextModel = model === undefined ? current.model : model || undefined;
  const effectiveModel = nextModel || DEFAULT_MODEL;
  if (reasoningEffort !== undefined && !reasoningEffortsForModel(effectiveModel).includes(reasoningEffort)) {
    return Response.json({ error: "This reasoning level is not supported by the selected model." }, { status: 400 });
  }
  writeConfig({
    ...current,
    model: nextModel,
    reasoningEffort: resolveReasoningEffort(effectiveModel, reasoningEffort ?? current.reasoningEffort),
  });
  return GET();
}
