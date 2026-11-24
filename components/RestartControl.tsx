"use client";

import { useEffect, useRef, useState } from "react";
import type { RestartStatus } from "@/lib/server/restart";
import { Spinner } from "./icons";

const plural = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;

/** Update & restart when idle: rebuild this checkout and swap servers once no
 * agent is working. Polls, so a restart asked for from the CLI shows here too,
 * and reloads the page once the new server answers. */
export default function RestartControl() {
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const swapping = useRef(false);

  useEffect(() => {
    const poll = async () => {
      try {
        const next: RestartStatus = await (await fetch("/api/restart")).json();
        if (swapping.current && next.phase === "idle") return location.reload();
        swapping.current = next.phase === "waiting" || next.phase === "restarting";
        setStatus(next);
      } catch {
        if (swapping.current) setStatus({ phase: "restarting", agents: 0 });
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, []);

  const request = async () => setStatus(await (await fetch("/api/restart", { method: "POST" })).json());

  if (!status) return null;
  const { phase, agents, error } = status;
  if (phase === "idle" || phase === "failed") {
    return (
      <button
        className={`rounded-lg px-2 py-1.5 text-xs hover:bg-zinc-200 ${phase === "failed" ? "text-red-600" : "text-zinc-600 hover:text-zinc-900"}`}
        onClick={() => void request().catch(() => {})}
        title={error ?? "Rebuild from the current code and restart once no agent is working"}
      >
        {phase === "failed" ? "Update failed — retry" : "Update & restart"}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5 px-2 text-xs text-zinc-500" role="status">
      <Spinner />
      {phase === "building" ? "Building update…" : phase === "waiting" && agents > 0 ? `Restart waiting for ${plural(agents)}` : "Restarting…"}
    </span>
  );
}
