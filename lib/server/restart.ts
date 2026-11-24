import { spawn } from "node:child_process";
import path from "node:path";
import { flushAll } from "./project-store";
import { registry } from "./run-registry";

/**
 * Update & restart when idle. The current checkout is built into the live
 * folder this server is not serving, while it keeps serving. Once that build
 * is ready, no new ticket run or agent turn starts (they stay queued, on disk);
 * when the ones at work have finished, a detached launcher stops this server
 * and starts the new build. A failed build leaves this server as it was.
 */

export type RestartPhase = "idle" | "building" | "waiting" | "restarting" | "failed";
export interface RestartStatus { phase: RestartPhase; agents: number; error?: string }
export interface RestartSteps {
  /** Resolves with the failure, or null once the build is ready. */
  build: (distDir: string) => Promise<string | null>;
  swap: (distDir: string) => void;
}

const globals = globalThis as unknown as {
  __autoprojectRestart?: { phase: RestartPhase; error?: string; serving?: string };
};
// The build folder this server serves, taken out of the environment: agents
// inherit it, and their own `npm run build` must never write into it.
const state = (globals.__autoprojectRestart ??= { phase: "idle", serving: process.env.AUTOPROJECT_DIST_DIR });
delete process.env.AUTOPROJECT_DIST_DIR;

/** Ticket sessions and project-agent turns at work. */
export const activeAgents = () => registry.controllers.size + registry.agents.size;

/** True once an update is built: nothing new may start before the swap. */
export const holdingForRestart = () => state.phase === "waiting" || state.phase === "restarting";

export const restartStatus = (): RestartStatus =>
  ({ phase: state.phase, agents: activeAgents(), ...(state.error ? { error: state.error } : {}) });

/** The launcher serves from `.next-live/a` or `.next-live/b`; build into the other. */
const nextDistDir = () => (state.serving === ".next-live/a" ? ".next-live/b" : ".next-live/a");

const fail = (error: string) => { state.phase = "failed"; state.error = error; };

export async function updateAndRestart(steps: RestartSteps = { build, swap }): Promise<void> {
  if (state.phase === "building" || holdingForRestart()) return;
  state.phase = "building";
  delete state.error;
  const distDir = nextDistDir();
  const error = await steps.build(distDir);
  if (error !== null) return fail(error);
  state.phase = "waiting";
  while (activeAgents() > 0) await new Promise((resolve) => setTimeout(resolve, 500));
  state.phase = "restarting";
  try { await flushAll(); }
  catch (err) { return fail(`Could not save projects before restarting: ${err instanceof Error ? err.message : err}`); }
  steps.swap(distDir);
}

function build(distDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn("npm", ["run", "build"], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOPROJECT_DIST_DIR: distDir, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The output goes to the server log; the tail is what the person is shown.
    const keep = (chunk: Buffer) => { process.stdout.write(chunk); tail = (tail + chunk).slice(-1500); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code) => resolve(code === 0 ? null : tail.trim() || `The build exited with code ${code}.`));
  });
}

/** Detached, so it outlives this server, which it stops before starting the new one. */
function swap(distDir: string): void {
  spawn(/* turbopackIgnore: true */ path.join(process.cwd(), "bin", "autoproject"),
    ["--replace", String(process.pid), "--port", process.env.PORT ?? "4123", "--no-open"],
    { detached: true, stdio: "inherit", env: { ...process.env, AUTOPROJECT_DIST_DIR: distDir } },
  ).on("error", (error) => fail(error.message)).unref();
}
