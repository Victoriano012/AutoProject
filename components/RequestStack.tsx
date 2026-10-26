"use client";

import { useSyncExternalStore } from "react";
import { modeColors } from "@/lib/mode-colors";
import { agentRequests, cancelRequest, retryRequest, subscribeRuns } from "@/lib/runner";
import type { AgentRequest } from "@/lib/types";

const NONE: AgentRequest[] = [];

/** The messages sent to the project agent that have not become tickets yet,
 * oldest first, each in the colour of the mode it was sent in — the chat
 * transcript's own two (see lib/mode-colors.ts), so a message reads the same
 * in both views — same background, no border round it either: the one being
 * worked on spins, the ones behind it wait dimmed in the same colour, a failed
 * one says why in red, and a stopped one waits quietly in grey — stopping
 * halts the work, it never throws the words away. Every row has a ✕ — stop,
 * cancel or dismiss, and dismissing puts the text back in the box — and a
 * halted row a retry. A request that finished is simply gone from here: its
 * tickets are on the board. Nothing renders while the stack is empty. */
export default function RequestStack({ onDropped }: { onDropped?: (text: string) => void }) {
  const requests = useSyncExternalStore(subscribeRuns, agentRequests, () => NONE);
  if (requests.length === 0) return null;

  const drop = (r: AgentRequest) => {
    cancelRequest(r.id);
    // The running one is only stopped by this, and stays in the stack as
    // stopped; every other row is leaving, so its words go back to the person.
    if (r.state !== "running") onDropped?.(r.text);
  };

  return (
    <div className="space-y-1.5 pb-2">
      {requests.map((r) => {
        const colors = modeColors(r.mode);
        return r.state === "error" || r.state === "stopped" ? (
          <div
            key={r.id}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${
              r.state === "error" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-600"
            }`}
          >
            <span
              className="min-w-0 flex-1 truncate"
              title={r.state === "error" ? `${r.text}\n\n${r.error}` : r.text}
            >
              {r.text}
              {r.state === "error" && ` — ${r.error}`}
            </span>
            {r.state === "stopped" && <span className="shrink-0 text-zinc-400">stopped</span>}
            <button
              className={`shrink-0 rounded-md px-2 py-0.5 ${
                r.state === "error"
                  ? "bg-red-200 text-red-700 hover:bg-red-300"
                  : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
              onClick={() => retryRequest(r.id)}
            >
              ↻ Retry
            </button>
            <button
              title="Dismiss and put the text back in the box"
              className={`shrink-0 ${
                r.state === "error" ? "text-red-400 hover:text-red-600" : "text-zinc-400 hover:text-red-600"
              }`}
              onClick={() => drop(r)}
            >
              ✕
            </button>
          </div>
        ) : (
          <div
            key={r.id}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-zinc-700 ${
              colors.bubble
            }${r.state === "running" ? "" : " opacity-50"}`}
          >
            {r.state === "running" ? (
              <span
                className={`h-3 w-3 shrink-0 animate-spin rounded-full border-2 ${colors.spinner}`}
              />
            ) : (
              <span className={`h-3 w-3 shrink-0 rounded-full border-2 ${colors.dot}`} />
            )}
            <span className="min-w-0 flex-1 truncate" title={r.text}>
              {r.text}
            </span>
            <span className="shrink-0 text-zinc-500">
              {r.state === "running"
                ? r.mode === "panel"
                  ? "breaking into tickets…"
                  : "working…"
                : "waiting"}
            </span>
            <button
              title={r.state === "running" ? "Stop this request" : "Cancel and put the text back in the box"}
              className="shrink-0 text-zinc-400 hover:text-red-600"
              onClick={() => drop(r)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
