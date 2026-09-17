import * as runs from "@/lib/server/runs";
import * as store from "@/lib/server/project-store";
import { runRequestSchema } from "@/lib/server/command-schemas";
export type { RunRequest } from "@/lib/server/command-schemas";

export const dynamic = "force-dynamic";

/** Commands acknowledge admission; long-running work reports through SSE and
 * belongs to the server, independent of the requesting tab's lifetime. */
export async function POST(req: Request) {
  const parsed = runRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid run command", details: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  const { dir, action } = body;
  if (!runs.ensureLoaded(dir)) return Response.json({ error: "Unknown project" }, { status: 404 });
  if (runs.registry.removing.has(dir)) return Response.json({ error: "Project is being removed" }, { status: 409 });
  const id = "ticketId" in body ? body.ticketId : "";
  if (id && !store.getProject(dir)?.tickets.some((ticket) => ticket.id === id)) {
    return Response.json({ error: "Unknown ticket" }, { status: 404 });
  }
  let background: Promise<void> | undefined;
  try {
    switch (action) {
      case "runTicket": background = runs.runTicket(dir, id); break;
      case "runProject": background = runs.runProject(dir); break;
      case "sendFeedback": background = runs.sendFeedback(dir, id, body.message); break;
      case "rejectTicket": background = runs.rejectTicket(dir, id, body.message); break;
      case "noteTicket": runs.noteTicket(dir, id, body.message); break;
      case "approveTicket": runs.approveTicket(dir, id); break;
      case "stopTicket": runs.stopTicket(dir, id); break;
      case "stopProject": runs.stopProject(dir, true); break;
      case "settleZombies": runs.settleZombies(dir); break;
      case "removeTickets": runs.removeTickets(dir, body.ticketIds); break;
    }
    if (background) void background.catch((error) => {
      const entry = { kind: "error" as const, text: String(error), ts: Date.now() };
      if (id) store.appendLog(dir, id, entry);
      else store.appendChat(dir, [{ ...entry, mode: "panel" }]);
      runs.notifyRuns(dir);
    });
    await store.flush(dir);
  } catch (error) {
    return Response.json({ error: String(error), dir, runs: runs.runState(dir) }, { status: 500 });
  }
  return Response.json({ ok: true, dir, runs: runs.runState(dir) }, { status: background ? 202 : 200 });
}

export async function GET(req: Request) {
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  if (!dir || !runs.ensureLoaded(dir)) return Response.json({ error: "Unknown project" }, { status: 404 });
  return Response.json({ dir, runs: runs.runState(dir) });
}
