import { type AppConfig, readConfig, writeConfig } from "@/lib/config";
import { DEFAULT_MODEL, type ReasoningEffort } from "@/lib/models";
import { reasoningEffortsForModel, resolveReasoningEffort } from "@/lib/server/model-settings";

export async function GET() {
  const config = readConfig();
  return Response.json({
    ...config,
    savedReasoningEffort: config.reasoningEffort,
    reasoningEffort: resolveReasoningEffort(config.model || DEFAULT_MODEL, config.reasoningEffort),
  });
}

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid settings." }, { status: 400 });
  }
  const { model } = body as AppConfig;
  if (model !== undefined && typeof model !== "string") {
    return Response.json({ error: "Invalid model." }, { status: 400 });
  }
  // An omitted key keeps the saved level; an explicit null asks for the CLI
  // default, which `??` alone cannot tell apart from "not sent".
  const sent = Object.hasOwn(body, "reasoningEffort");
  const reasoningEffort = (body as { reasoningEffort?: ReasoningEffort | null }).reasoningEffort;
  const current = readConfig();
  const nextModel = model === undefined ? current.model : model || undefined;
  const effectiveModel = nextModel || DEFAULT_MODEL;
  if (reasoningEffort != null && !reasoningEffortsForModel(effectiveModel).includes(reasoningEffort)) {
    return Response.json({ error: "This reasoning level is not supported by the selected model." }, { status: 400 });
  }
  writeConfig({
    ...current,
    model: nextModel,
    reasoningEffort: resolveReasoningEffort(effectiveModel, sent ? reasoningEffort : current.reasoningEffort),
  });
  return GET();
}
