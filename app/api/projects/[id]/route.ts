import { assertManagedProject, eraseProject, hideProject } from "@/lib/projects-fs";
import { flush, forget, getProject, publish, setProject } from "@/lib/server/project-store";
import { autoRun, ensureLoaded, ownsTicket } from "@/lib/server/runs";
import { finishProjectRemoval, isProjectRemoving, prepareProjectRemoval } from "@/lib/server/project-lifecycle";
import { applyProjectPatch, EditConflict, type ProjectPatch } from "@/lib/project-edits";
import { projectPatchSchema } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id: dir } = await ctx.params;
  const project = ensureLoaded(dir);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: dir, name: project.name, data: project });
}

/** Field comparisons allow unrelated edits from stale tabs, but reject collisions. */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id: dir } = await ctx.params;
  const parsed = projectPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid project changes", issues: parsed.error.issues }, { status: 400 });
  if (isProjectRemoving(dir)) return Response.json({ error: "Project is being removed" }, { status: 409 });
  if (!ensureLoaded(dir)) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const current = getProject(dir)!;
    setProject(dir, applyProjectPatch(current, parsed.data as ProjectPatch, (id) => ownsTicket(dir, id)));
    await flush(dir);
    if (isProjectRemoving(dir)) return Response.json({ error: "Project is being removed" }, { status: 409 });
    const project = getProject(dir)!;
    publish(dir, { type: "project", project });
    autoRun(dir);
    return Response.json({ data: project });
  } catch (error) {
    if (error instanceof EditConflict) return Response.json({ error: error.message, data: getProject(dir) }, { status: 409 });
    return Response.json({ error: error instanceof Error ? error.message : "Could not save project" }, { status: 500 });
  }
}

export async function PUT() {
  return Response.json({ error: "This tab uses an older save format. Reload before editing." }, { status: 409 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id: dir } = await ctx.params;
  const mode = new URL(req.url).searchParams.get("mode") ?? "hide";
  if (mode !== "hide" && mode !== "erase") return Response.json({ error: "Invalid removal mode" }, { status: 400 });
  try {
    assertManagedProject(dir);
    if (mode === "erase") {
      await prepareProjectRemoval(dir);
      try { await forget(dir); eraseProject(dir); }
      finally { finishProjectRemoval(dir); }
    } else {
      const held = getProject(dir);
      if (held) { setProject(dir, { ...held, hidden: true }); await flush(dir); }
      else hideProject(dir);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not remove project" }, { status: 400 });
  }
}
