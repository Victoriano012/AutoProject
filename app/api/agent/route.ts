import { cancelRequest, retryRequest, sendToAgent, stopAgent } from "@/lib/server/project-agent";
import { agentRequestSchema } from "@/lib/server/command-schemas";
import { ensureLoaded, registry } from "@/lib/server/runs";
import { flush } from "@/lib/server/project-store";

export async function POST(req: Request) {
  const parsed = agentRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid agent command", details: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  if (!ensureLoaded(body.dir)) return Response.json({ error: "Unknown project" }, { status: 404 });
  if (registry.removing.has(body.dir)) return Response.json({ error: "Project is being removed" }, { status: 409 });
  try {
    switch (body.action) {
      case "stop": stopAgent(body.dir); break;
      case "cancel": cancelRequest(body.dir, body.id); break;
      case "retry": retryRequest(body.dir, body.id); break;
      case "send": sendToAgent(body.dir, body.mode, body.message); break;
    }
    await flush(body.dir);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
  return new Response(null, { status: body.action === "send" || body.action === "retry" ? 202 : 204 });
}
