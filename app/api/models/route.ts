import { selectedModel } from "@/lib/config";
import { withSelectedModel } from "@/lib/models";
import { catalogModels, knownModels, modelCatalog, MODEL_CACHE_TTL_MS } from "@/lib/server/model-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function catalogResponse(force: boolean) {
  const catalog = await modelCatalog.refresh(force);
  return Response.json({
    models: withSelectedModel(catalogModels(catalog), selectedModel(), knownModels(catalog)),
    providers: Object.fromEntries(Object.entries(catalog.providers).map(([provider, { source, error, lastSuccessAt }]) => [provider, { source, error, lastSuccessAt }])),
    checkedAt: catalog.checkedAt,
    cacheTtlMs: MODEL_CACHE_TTL_MS,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() { return catalogResponse(false); }
export async function POST() { return catalogResponse(true); }
