/** Runs once as a server starts (and in build workers, which must not touch
 * projects): work the last server's update & restart cut short carries on
 * (see lib/server/restart.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { resumeAfterRestart } = await import("./lib/server/runs");
  resumeAfterRestart();
}
