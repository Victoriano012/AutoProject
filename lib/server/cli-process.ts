import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AgentRequest } from "./agent-types";

interface CliOptions {
  label: string;
  executable: string;
  args: (schemaPath?: string) => string[];
  stdin?: string;
  /** Production callers use the default; a short interval keeps fake CLI
   * cancellation tests fast without changing application configuration. */
  killAfterMs?: number;
}

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Own one CLI process from launch through actual exit, including iterator
 * cancellation. Provider modules only translate their distinct event formats. */
export async function createCliSession(req: AgentRequest, options: CliOptions) {
  let schemaDir: string | undefined;
  let schemaPath: string | undefined;
  if (req.outputSchema) {
    schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoproject-schema-"));
    schemaPath = path.join(schemaDir, "schema.json");
    try { await fs.writeFile(schemaPath, JSON.stringify(req.outputSchema), { mode: 0o600 }); }
    catch (error) { await fs.rm(schemaDir, { recursive: true, force: true }); throw error; }
  }

  let child;
  try {
    child = spawn(/* turbopackIgnore: true */ options.executable, options.args(schemaPath), {
      cwd: req.workspaceDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    if (schemaDir) await fs.rm(schemaDir, { recursive: true, force: true });
    throw error;
  }

  let spawnError: Error | undefined;
  let stderr = "";
  let closed = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exit = new Promise<ExitStatus>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      closed = true;
      // The CLI may exit before a tool which ignored SIGINT. Do not leave its
      // process group writing the workspace after the run releases ownership.
      if (stopping && process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* no group remains */ }
      }
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal });
    });
  });
  const signalProcess = (signal: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    if (closed || killTimer) return;
    stopping = true;
    signalProcess("SIGINT");
    killTimer = setTimeout(() => signalProcess("SIGKILL"), options.killAfterMs ?? 8000);
    killTimer.unref?.();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
  // A process that rejects its arguments can exit before reading the prompt.
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin);
  req.signal.addEventListener("abort", stop);
  if (req.signal.aborted) stop();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  async function* events(): AsyncGenerator<Record<string, unknown>> {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (event && typeof event === "object" && !Array.isArray(event)) {
        yield event as Record<string, unknown>;
      }
    }
  }

  return {
    events: events(),
    exit,
    failure(status: ExitStatus, missingCliMessage: string): string {
      if (spawnError) return (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? missingCliMessage : spawnError.message;
      if (req.signal.aborted) return "Agent stopped";
      return stderr.trim() || `${options.label} exited ${status.signal ? `with ${status.signal}` : `with code ${status.code}`}`;
    },
    async close() {
      req.signal.removeEventListener("abort", stop);
      stop();
      await exit;
      lines.close();
      if (killTimer) clearTimeout(killTimer);
      if (schemaDir) await fs.rm(schemaDir, { recursive: true, force: true });
    },
  };
}

export function parseStructured(text: string, provider: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (error) { return { ok: false, message: `${provider} returned invalid structured output: ${String(error)}` }; }
}
