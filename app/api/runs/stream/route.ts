import { getProject, persistenceStatus, type ProjectEvent, subscribe } from "@/lib/server/project-store";
import * as runs from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/** Live run feed for one project: a snapshot on connect, then every status
 * change, log line and run-registry change the server produces. Server-Sent
 * Events on the default Node runtime — the browser reconnects on its own, and
 * the snapshot makes a reconnect (or a page reload) catch up in one step. */
export async function GET(req: Request) {
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  if (!dir || !runs.ensureLoaded(dir)) {
    return new Response("Unknown project", { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const send = (data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      // Snapshot and subscription in the same tick, so no event slips between.
      send({ type: "snapshot", project: getProject(dir), runs: runs.runState(dir) });
      const unsubscribe = subscribe(dir, (e: ProjectEvent) =>
        e.type === "runs" ? send({ type: "runs", runs: runs.runState(dir) }) : send(e)
      );
      // Often enough that the browser can tell a live feed from one that died
      // without saying so — its watchdog counts missed pings (see sync.ts).
      const ping = setInterval(() => send({ type: "ping" }), 10_000);
      ping.unref?.();

      cleanup = () => {
        open = false;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const release = cleanup;
      cleanup = () => { req.signal.removeEventListener("abort", cleanup); release(); };
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) cleanup();
      else send({ type: "persistence", error: persistenceStatus(dir) });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
