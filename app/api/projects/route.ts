import { createProject, importProject, listProjects } from "@/lib/projects-fs";
import { createProjectSchema } from "@/lib/schemas";
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
  const parsed = createProjectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A valid project name or folder path is required" }, { status: 400 });
  try {
    const row = "path" in parsed.data ? importProject(parsed.data.path) : createProject(parsed.data.name);
    return Response.json(row);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
