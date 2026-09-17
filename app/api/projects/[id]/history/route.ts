import { getProject, flush } from "@/lib/server/project-store";
import { readProjectHistory } from "@/lib/server/project-history";

export const runtime = "nodejs";

/** Full transcripts are paged from the append-only journal. Project snapshots
 * carry only the recent window so live clients and autosaves stay bounded.
 * `cursor` is opaque: return each nextCursor unchanged, never increment it. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const dir = id;
  if (!getProject(dir)) return Response.json({ error: "Not found" }, { status: 404 });
  const query = new URL(request.url).searchParams;
  const cursor = Number(query.get("cursor") ?? 0);
  const limit = Number(query.get("limit") ?? 200);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return Response.json({ error: "cursor must be a nonnegative integer; limit must be 1–1000" }, { status: 400 });
  }
  try {
    await flush(dir);
    return Response.json(await readProjectHistory(dir, { ticketId: query.get("ticketId") ?? undefined, cursor, limit }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to read history" }, { status: 500 });
  }
}
