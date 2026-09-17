"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { LogEntry } from "@/lib/types";
import TranscriptDownload from "./TranscriptDownload";

/**
 * An agent transcript: the card's log, shown on the card the person pressed,
 * and the project agent's chat.
 *
 * Its height is fixed, whatever the log holds: the board's cards sit in a
 * column, so a box that grew with the log would shove everything under it
 * around while the agent works. It opens on the newest entry — set before
 * paint, so the top is never seen — and keeps following the newest one, unless
 * the person has scrolled up to read, which stops the following until they
 * come back to the bottom.
 */
export function LogView({ entries: log, ticketId }: { entries: LogEntry[]; ticketId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [pageEnd, setPageEnd] = useState<number | null>(null);
  const end = Math.min(pageEnd ?? log.length, log.length);
  const start = Math.max(0, end - 200);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log, pageEnd]);

  if (log.length === 0) {
    return (
      <div className="mt-2 text-[11px] italic text-zinc-400">
        Nothing from the agent yet.
      </div>
    );
  }
  return (
    <>
    <TranscriptDownload ticketId={ticketId} />
    <div
      ref={ref}
      // Reading and scrolling the log is not a press on the card: dragging its
      // scrollbar must not collapse it.
      onClick={(e) => e.stopPropagation()}
      onScroll={() => {
        const el = ref.current;
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="mt-2 h-32 space-y-1 overflow-y-auto overscroll-contain text-[11px] leading-snug"
    >
      {start > 0 && <button className="text-violet-600" onClick={() => {
        pinned.current = false;
        setPageEnd(Math.max(200, start));
        if (ref.current) ref.current.scrollTop = 0;
      }}>Show earlier entries ({start} older)</button>}
      {log.slice(start, end).map((e, index) => {
        const i = start + index;
        switch (e.kind) {
          case "tool":
            return (
              <div key={i} className="truncate font-mono text-zinc-400">
                {e.text}
              </div>
            );
          case "user":
            return (
              <div
                key={i}
                className="whitespace-pre-wrap bg-violet-50 px-1.5 py-0.5 text-zinc-700"
              >
                <span className="text-violet-400">&gt; </span>
                {e.text}
              </div>
            );
          case "error":
            // A stop the person asked for is not a failure — show it like info.
            return e.text.startsWith("Stopped by user") ? (
              <div key={i} className="truncate font-mono italic text-zinc-400">
                {e.text}
              </div>
            ) : (
              <div key={i} className="whitespace-pre-wrap text-red-600">
                {e.text}
              </div>
            );
          case "info":
            return (
              <div key={i} className="truncate font-mono italic text-zinc-400">
                {e.text}
              </div>
            );
          default:
            return (
              <div key={i} className="whitespace-pre-wrap text-zinc-600">
                {e.text}
              </div>
            );
        }
      })}
      {end < log.length && <button className="text-violet-600" onClick={() => {
        const next = Math.min(log.length, end + 200);
        pinned.current = next === log.length;
        setPageEnd(next === log.length ? null : next);
        if (ref.current) ref.current.scrollTop = 0;
      }}>Show newer entries ({log.length - end} newer)</button>}
      {pageEnd !== null && <button className="ml-2 text-violet-600" onClick={() => {
        pinned.current = true;
        setPageEnd(null);
      }}>Jump to latest</button>}
    </div>
    </>
  );
}
