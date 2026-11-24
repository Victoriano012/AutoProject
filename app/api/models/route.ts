import { selectedModel } from "@/lib/config";
import { withSelectedModel } from "@/lib/models";
import { catalogModels, knownModels, modelCatalog, type ModelCatalog } from "@/lib/server/model-catalog";
import { codexUpdateState } from "@/lib/server/model-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function catalogResponse(catalog: ModelCatalog) {
  return Response.json({
    models: withSelectedModel(catalogModels(catalog), selectedModel(), knownModels(catalog)),
    providers: Object.fromEntries(Object.entries(catalog.providers).map(([provider, { source, error, lastSuccessAt, version }]) => [provider, { source, error, lastSuccessAt, version }])),
    checkedAt: catalog.checkedAt,
    // While "updating", Settings asks again until the new Codex's models land.
    codexUpdate: codexUpdateState(),
  }, { headers: { "Cache-Control": "no-store" } });
}

/** Opening Settings must not spawn three CLIs and wait on them: answer from the
 * stored catalog, and discover only when someone presses refresh. */
export function GET() { return catalogResponse(modelCatalog.read()); }
export async function POST() { return catalogResponse(await modelCatalog.refresh()); }
