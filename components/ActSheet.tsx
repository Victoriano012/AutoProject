"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { agentBusy, agentRequests, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { AgentRequest } from "@/lib/types";
import TranscriptDownload from "./TranscriptDownload";

/**
 * The project agent's conversation, slid up over the board when the person
 * switches to act mode and back down when they leave it.
 *
 * Mounted only while it is on screen or on its way off: `open` flipping true
 * mounts it below the fold and sends it up; flipping false sends it down and
 * unmounts it once the transform has finished travelling (see `.act-sheet` in
 * globals.css). Clicks pass through it until it has fully arrived, so a press
 * meant for the board mid-flight does not land on the chat. The transition's
 * end is what moves it on, with a timer behind it for the reduced-motion case
 * where there is no transition to end.
 */
/** Where the sheet is on its way: travelling up, in place, or travelling down
 * (then unmounted). */
type Phase = "closed" | "entering" | "open" | "leaving";

export default function ActSheet({ open }: { open: boolean }) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const ref = useRef<HTMLDivElement>(null);

  // Answered on render, not in an effect, so the sheet moves the same frame
  // `open` changes. A flip mid-flight just changes the destination: the
  // transition reverses from wherever the sheet is.
  if (open && (phase === "closed" || phase === "leaving")) setPhase("entering");
  if (!open && (phase === "open" || phase === "entering")) setPhase("leaving");

  useEffect(() => {
    // Reduced motion has no transition to end, so the arrival is timed too.
    const timer = setTimeout(
      () =>
        setPhase((p) =>
          open ? (p === "entering" ? "open" : p) : p === "leaving" ? "closed" : p
        ),
      650
    );
    return () => clearTimeout(timer);
  }, [open]);

  // The sheet's position is set on the DOM here rather than rendered: on the
  // way in it has to be resolved once at the bottom before it is told to go
  // up, or the browser sees only the end state and it appears in place with
  // nothing to travel. Reading layout forces that first resolution; a frame
  // gap (rAF) did not, since React can fold both states into one paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (phase === "entering") void el.getBoundingClientRect();
    el.dataset.open = String(phase === "entering" || phase === "open");
  }, [phase]);

  if (phase === "closed") return null;
  return (
    <div
      ref={ref}
      className={`act-sheet absolute inset-0 z-20 bg-white flex flex-col${
        phase === "open" ? "" : " pointer-events-none"
      }`}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
        setPhase((p) => (p === "entering" ? "open" : p === "leaving" ? "closed" : p));
      }}
    >
      <Transcript />
    </div>
  );
}

const NONE: AgentRequest[] = [];

function Transcript() {
  const chat = useStore((s) => s.project.chat);
  const busy = useSyncExternalStore(subscribeRuns, agentBusy, () => false);
  // A chat message the running turn could not take (another mode's turn, or a
  // CLI with no way in mid-turn) waits in the queue; it shows here, dimmed,
  // until its turn starts and writes it to the transcript for real.
  const requests = useSyncExternalStore(subscribeRuns, agentRequests, () => NONE);
  const waiting = requests.filter((r) => r.mode === "act" && r.state === "queued");
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [pageEnd, setPageEnd] = useState<number | null>(null);
  const end = Math.min(pageEnd ?? chat.length, chat.length);
  const start = Math.max(0, end - 200);

  useEffect(() => {
    if (pinned.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat, waiting.length, busy, pageEnd]);

  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2" onScroll={() => {
      const el = listRef.current;
      if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }}>
      <TranscriptDownload />
      {start > 0 && <button className="text-sm text-violet-600" onClick={() => {
        pinned.current = false;
        setPageEnd(Math.max(200, start));
        if (listRef.current) listRef.current.scrollTop = 0;
      }}>Show earlier messages ({start} older)</button>}
      {chat.slice(start, end).map((m, index) => {
        const i = start + index;
        switch (m.kind) {
          case "user":
            // The two modes do different things with what was sent, so each
            // message's background says which: amber for the board (panel),
            // sky for the chat (act).
            return (
              <p
                key={i}
                className={`rounded px-2 py-1 font-mono text-sm text-zinc-700 whitespace-pre-wrap ${
                  m.mode === "panel" ? "bg-amber-100" : "bg-sky-100"
                }`}
              >
                <span className="text-zinc-400">&gt; </span>
                {m.text}
              </p>
            );
          case "tool":
            return (
              <p key={i} className="overflow-hidden text-ellipsis whitespace-pre font-mono text-xs text-zinc-400">
                {m.text}
              </p>
            );
          case "info":
            return (
              <p key={i} className="truncate font-mono text-xs italic text-zinc-400">
                {m.text}
              </p>
            );
          case "error":
            return (
              <p key={i} className="font-mono text-sm text-red-600 whitespace-pre-wrap">
                {m.text}
              </p>
            );
          default:
            return (
              <p key={i} className="font-mono text-sm text-zinc-800 whitespace-pre-wrap">
                {m.text}
              </p>
            );
        }
      })}
      {end < chat.length && <button className="text-sm text-violet-600" onClick={() => {
        const next = Math.min(chat.length, end + 200);
        pinned.current = next === chat.length;
        setPageEnd(next === chat.length ? null : next);
        if (listRef.current) listRef.current.scrollTop = 0;
      }}>Show newer messages ({chat.length - end} newer)</button>}
      {pageEnd !== null && <button className="ml-2 text-sm text-violet-600" onClick={() => {
        pinned.current = true;
        setPageEnd(null);
      }}>Jump to latest</button>}
      {waiting.map((r) => (
        <p
          key={r.id}
          title="Waiting for the agent's current turn to end"
          className="rounded bg-sky-100 px-2 py-1 font-mono text-sm text-zinc-700 whitespace-pre-wrap opacity-50"
        >
          <span className="text-zinc-400">&gt; </span>
          {r.text}
        </p>
      ))}
      {busy && (
        <p className="font-mono text-sm text-zinc-500 animate-pulse whitespace-pre-wrap">
          Working…
        </p>
      )}
    </div>
  );
}
