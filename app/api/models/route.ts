import { selectedModel } from "@/lib/config";
import { withSelectedModel } from "@/lib/models";
import { catalogModels, knownModels, modelCatalog, type ModelCatalog } from "@/lib/server/model-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function catalogResponse(catalog: ModelCatalog) {
  return Response.json({
    models: withSelectedModel(catalogModels(catalog), selectedModel(), knownModels(catalog)),
    providers: Object.fromEntries(Object.entries(catalog.providers).map(([provider, { source, error, lastSuccessAt }]) => [provider, { source, error, lastSuccessAt }])),
    checkedAt: catalog.checkedAt,
  }, { headers: { "Cache-Control": "no-store" } });
}

/** Opening Settings must not spawn three CLIs and wait on them: answer from the
 * stored catalog, and discover only when someone presses refresh. */
export function GET() { return catalogResponse(modelCatalog.read()); }
export async function POST() { return catalogResponse(await modelCatalog.refresh()); }
