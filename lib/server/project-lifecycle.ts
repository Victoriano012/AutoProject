import { registry } from "./run-registry";
import { stopProject } from "./runs";

export function isProjectRemoving(dir: string): boolean { return registry.removing.has(dir); }

/** Close the admission gate before stopping anything, then wait for every
 * owner to release its workspace. The caller may delete only after this resolves. */
export async function prepareProjectRemoval(dir: string): Promise<void> {
  if (registry.removing.has(dir)) throw new Error("Project is already being removed");
  registry.removing.add(dir);
  // The project is going, and its stack with it: nothing could retry those
  // requests or put their words back in a box that will not exist. Cleared
  // before the stop, which on its own keeps every request (see stopProject),
  // so the same stop publishes and persists the empty stack.
  registry.requests.set(dir, []);
  stopProject(dir, true);
  await Promise.allSettled([
    ...[...registry.claims.values()].filter((claim) => claim.dir === dir).map((claim) => claim.done),
    registry.agentTasks.get(dir),
    registry.loopTasks.get(dir),
  ]);
}

/** Call after removal (or a failed removal) to permit this directory to be
 * opened/recreated later. All processes have already exited at this point. */
export function finishProjectRemoval(dir: string): void {
  registry.removing.delete(dir);
  registry.requests.delete(dir);
  registry.agentMode.delete(dir);
  registry.subagents.delete(dir);
  registry.inputs.delete(dir);
  const prefix = dir + "\u0000";
  for (const key of registry.userStopped) if (key.startsWith(prefix)) registry.userStopped.delete(key);
}
