import { restartStatus, updateAndRestart } from "@/lib/server/restart";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(restartStatus());
}

/** Update & restart when idle; progress is read back through GET. */
export function POST() {
  void updateAndRestart().catch((error) => console.error("Update & restart failed", error));
  return Response.json(restartStatus(), { status: 202 });
}
