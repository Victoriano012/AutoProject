import { createProject, importProject, listProjects } from "@/lib/projects-fs";
import { isProjectRunning, runState } from "@/lib/server/runs";

/** Rows come with the project's live status. The file only knows the tickets;
 * the project agent mid-turn, or a whole-project run going, is work too — it
 * lives in the run registry, which is this side of the file layer. */
export async function GET() {
  const projects = listProjects().map((r) => ({
    ...r,
    status: {
      ...r.status,
      working:
        r.status.working ||
        isProjectRunning(r.id) ||
        runState(r.id).agent.requests.some((req) => req.state === "running"),
    },
  }));
  return Response.json({ projects });
}

/** {name} creates a new folder under the base dir; {path} imports any folder. */
export async function POST(req: Request) {
  const { name, path } = (await req.json()) as { name?: string; path?: string };
  try {
    const row = path ? importProject(path) : createProject(name || "Untitled project");
    return Response.json(row);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
