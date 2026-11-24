import { spawn } from "node:child_process";
import path from "node:path";
import { flushAll } from "./project-store";
import { registry } from "./run-registry";

/**
 * Update & restart. The current checkout is built into the live folder this
 * server is not serving, while it keeps serving. Once that build is ready,
 * every agent at work is cut short (see `suspended`) and saved to pick up
 * again in its same conversation, and a detached launcher stops this server
 * and starts the new build, whose startup resumes them (see
 * `resumeAfterRestart` in runs.ts). A failed build leaves this server as it was.
 */

type RestartPhase = "idle" | "building" | "restarting" | "failed";
export interface RestartSteps {
  /** Resolves with the failure, or null once the build is ready. */
  build: (distDir: string) => Promise<string | null>;
  swap: (distDir: string) => void;
}

const globals = globalThis as unknown as {
  __autoprojectRestart?: { phase: RestartPhase; serving?: string };
};
// The build folder this server serves, taken out of the environment: agents
// inherit it, and their own `npm run build` must never write into it.
const state = (globals.__autoprojectRestart ??= { phase: "idle", serving: process.env.AUTOPROJECT_DIST_DIR });
delete process.env.AUTOPROJECT_DIST_DIR;

/** The abort reason of work cut short for a restart. Such work writes no
 * stop, error or failure: it is saved for the next server instead. */
const RESTART = "AutoProject is restarting";
export const suspended = (signal: AbortSignal) => signal.aborted && signal.reason === RESTART;

/** What a cut-short agent is told when it picks its work up again. */
export function restartNote(stoppedSubagents: string[] = []): string {
  return (
    "AutoProject was restarted to apply an update, and the update is now live. The restart " +
    "interrupted you: carry on from where you left off, redoing the step you were on if it did " +
    "not finish. If you ran `bin/autoproject --restart` yourself, it has done its job; do not run it again." +
    (stoppedSubagents.length
      ? `\n\nThe restart stopped these subagents before they finished; start again any you still need:\n` +
        stoppedSubagents.map((s) => `- ${s}`).join("\n")
      : "")
  );
}

/** From the moment the update is built until the swap, nothing new starts. */
export const holdingForRestart = () => state.phase === "restarting";

export const restartStatus = () => ({ phase: state.phase });

/** The launcher serves from `.next-live/a` or `.next-live/b`; build into the other. */
const nextDistDir = () => (state.serving === ".next-live/a" ? ".next-live/b" : ".next-live/a");

/** The reason goes to the server log, beside the build output. */
const fail = (error: string) => { state.phase = "failed"; console.error(`Update & restart failed: ${error}`); };

export async function updateAndRestart(steps: RestartSteps = { build, swap }): Promise<void> {
  if (state.phase === "building" || holdingForRestart()) return;
  state.phase = "building";
  const distDir = nextDistDir();
  const error = await steps.build(distDir);
  if (error !== null) return fail(error);
  state.phase = "restarting";
  for (const run of [...registry.controllers.values(), ...registry.agents.values()]) run.abort(RESTART);
  await Promise.all([...[...registry.claims.values()].map((claim) => claim.done), ...registry.agentTasks.values()]);
  try { await flushAll(); }
  catch (err) { return fail(`Could not save projects before restarting: ${err instanceof Error ? err.message : err}`); }
  steps.swap(distDir);
}

function build(distDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Its output goes to the server log.
    const child = spawn("npm", ["run", "build"], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOPROJECT_DIST_DIR: distDir, NODE_ENV: "production" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code) => resolve(code === 0 ? null : `The build exited with code ${code}.`));
  });
}

/** Detached, so it outlives this server, which it stops before starting the new one. */
function swap(distDir: string): void {
  spawn(/* turbopackIgnore: true */ path.join(process.cwd(), "bin", "autoproject"),
    ["--replace", String(process.pid), "--port", process.env.PORT ?? "4123", "--no-open"],
    { detached: true, stdio: "inherit", env: { ...process.env, AUTOPROJECT_DIST_DIR: distDir } },
  ).on("error", (error) => fail(error.message)).unref();
}
