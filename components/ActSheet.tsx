"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { takeBackDraft } from "@/lib/draft";
import { modeColors } from "@/lib/mode-colors";
import { agentBusy, agentRequests, cancelRequest, retryRequest, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { AgentRequest, ChatEntry, Ticket } from "@/lib/types";
import { TicketIcon } from "./icons";
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

/** What a request that has not reached the agent is doing. */
function pendingLabel(request: AgentRequest): string {
  switch (request.state) {
    case "queued":
      return "waiting";
    case "running":
      return "working…";
    case "stopped":
      return "stopped";
    case "error":
      return request.error ?? "failed";
  }
}

/** A message the person sent that the agent has not been told yet: the same
 * bubble it will become in the transcript, dimmed, under a line saying where
 * it stands. A halted one — failed or stopped — carries the stack's two
 * answers with it, so the chat is not a dead end: send it again, or take the
 * words back into the box. The mode's colour is the transcript's (amber for
 * the board, sky for the chat): one message looks the same either side of
 * being heard. */
function PendingMessage({ request }: { request: AgentRequest }) {
  const halted = request.state === "error" || request.state === "stopped";
  return (
    <div
      className={`rounded px-2 py-1 ${modeColors(request.mode).bubble}`}
    >
      <p className="font-mono text-sm text-zinc-700 whitespace-pre-wrap opacity-50">
        <span className="text-zinc-400">&gt; </span>
        {request.text}
      </p>
      <p className="flex items-center gap-2 text-xs">
        <span
          className={`min-w-0 flex-1 truncate ${
            request.state === "error" ? "text-red-600" : "text-zinc-500"
          }`}
          title={pendingLabel(request)}
        >
          {pendingLabel(request)}
        </span>
        {halted && (
          <button
            className="shrink-0 rounded-md bg-white/60 px-2 py-0.5 text-zinc-700 hover:bg-white"
            onClick={() => retryRequest(request.id)}
          >
            ↻ Retry
          </button>
        )}
        {halted && (
          <button
            title="Dismiss and put the text back in the box"
            className="shrink-0 text-zinc-400 hover:text-red-600"
            onClick={() => {
              cancelRequest(request.id);
              takeBackDraft(request.text);
            }}
          >
            ✕
          </button>
        )}
      </p>
    </div>
  );
}

/** The cards one chat entry put on the board: carried on the entry, or — for
 * entries written before it carried them — resolved from the board by id.
 * Empty when the entry made no cards, or when an older one's cards are gone
 * and there are no titles left to show: that entry falls back to its text. */
function createdTickets(entry: ChatEntry, board: Ticket[]): { id: string; title: string }[] {
  if (entry.tickets?.length) return entry.tickets;
  const resolved = (entry.ticketIds ?? []).flatMap((id) => {
    const title = board.find((t) => t.id === id)?.title;
    return title ? [{ id, title }] : [];
  });
  return resolved.length === (entry.ticketIds?.length ?? 0) ? resolved : [];
}

/** One card the planner added, in the stream where it appeared: the whole
 * title, and a click to it on the board. A card since deleted stays readable
 * but leads nowhere. */
function CreatedTicket({ id, title, onBoard }: { id: string; title: string; onBoard: boolean }) {
  const select = useStore((s) => s.select);
  const setMode = useStore((s) => s.setMode);
  const row = "flex w-full items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-left text-sm text-violet-900";
  const body = (
    <>
      <span className="shrink-0 text-violet-500">
        <TicketIcon size={14} />
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{title}</span>
    </>
  );
  return onBoard ? (
    <button
      className={`${row} hover:bg-violet-100`}
      onClick={() => {
        select(id);
        setMode("panel");
      }}
    >
      {body}
    </button>
  ) : (
    <div className={`${row} opacity-60`}>{body}</div>
  );
}

function Transcript() {
  const chat = useStore((s) => s.project.chat);
  const board = useStore((s) => s.project.tickets);
  const busy = useSyncExternalStore(subscribeRuns, agentBusy, () => false);
  // Everything sent that the agent has not been told yet — waiting its turn,
  // waiting for capacity, failed, stopped — shows here dimmed, in the order it
  // was sent, until the turn says it to the agent and the transcript carries
  // it for real. `heard`, not the state: a request is "running" for the whole
  // wait for capacity, and that wait used to show nothing at all.
  const requests = useSyncExternalStore(subscribeRuns, agentRequests, () => NONE);
  const pending = requests.filter((r) => !r.heard);
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [pageEnd, setPageEnd] = useState<number | null>(null);
  const end = Math.min(pageEnd ?? chat.length, chat.length);
  const start = Math.max(0, end - 200);

  useEffect(() => {
    if (pinned.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat, pending.length, busy, pageEnd]);

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
            // message's background says which (see lib/mode-colors.ts).
            return (
              <p
                key={i}
                className={`rounded px-2 py-1 font-mono text-sm text-zinc-700 whitespace-pre-wrap ${
                  modeColors(m.mode).bubble
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
          case "info": {
            // Cards the planner added are the message: one row each, the whole
            // title, rather than a line of the stream saying how many.
            const created = createdTickets(m, board);
            return created.length ? (
              <div key={i} className="space-y-1">
                {created.map((t) => (
                  <CreatedTicket
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    onBoard={board.some((b) => b.id === t.id)}
                  />
                ))}
              </div>
            ) : (
              <p key={i} className="truncate font-mono text-xs italic text-zinc-400">
                {m.text}
              </p>
            );
          }
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
      {pending.map((r) => (
        <PendingMessage key={r.id} request={r} />
      ))}
      {busy && (
        <p className="font-mono text-sm text-zinc-500 animate-pulse whitespace-pre-wrap">
          Working…
        </p>
      )}
    </div>
  );
}
