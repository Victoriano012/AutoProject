"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { createBoardIndex, createBoardTicketSelector } from "@/lib/board-index";
import { boardColumn, byArrival, type BoardColumn, type Ticket, type TicketStatus } from "@/lib/types";
import TicketCard from "./board/TicketCard";
import { useBoardAnimation } from "./board/useBoardAnimation";

const COLUMNS: { id: BoardColumn; title: string; tint: string; header: string }[] = [
  { id: "blocked", title: "Blocked", tint: "border-zinc-200 bg-zinc-100/70", header: "text-zinc-500" },
  { id: "working", title: "Working", tint: "border-blue-200 bg-blue-50", header: "text-blue-600" },
  { id: "review", title: "Ready for review", tint: "border-yellow-200 bg-yellow-50", header: "text-yellow-700" },
  { id: "done", title: "Done", tint: "border-emerald-200 bg-emerald-50", header: "text-emerald-700" },
];

export default function BoardView() {
  const projectId = useStore((s) => s.projectId);
  return <ProjectBoard key={projectId} />;
}

/** Metadata drives columns and contention. Transcript updates reach only the
 * selected card's log, keeping board derivation and layout off that hot path. */
function ProjectBoard() {
  const [error, setError] = useState<string | null>(null);
  const [selector] = useState(createBoardTicketSelector);
  const tickets = useStore(selector);
  const workers = useStore((s) => s.project.workers);
  const projectLoaded = useStore((s) => s.projectLoaded);
  const index = useMemo(() => createBoardIndex(tickets), [tickets]);
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);
  const [pending, setPending] = useState<Record<string, { becomes: TicketStatus; was: TicketStatus; at: number }>>({});
  const hold = useCallback((t: Ticket, becomes: TicketStatus | null) => {
    setPending((p) => {
      const next = { ...p };
      if (becomes) next[t.id] = { becomes, was: t.status, at: Date.now() };
      else delete next[t.id];
      return next;
    });
  }, []);
  useEffect(() => {
    const ids = Object.keys(pending);
    if (!ids.length) return;
    const prune = () => setPending((current) => {
      const next = { ...current };
      for (const id of Object.keys(next)) {
        if (index.ticketById.get(id)?.status !== next[id].was || Date.now() - next[id].at >= 10_000) delete next[id];
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    prune();
    const timer = setTimeout(prune, Math.max(0, Math.min(...ids.map((id) => pending[id].at + 10_000 - Date.now()))));
    return () => clearTimeout(timer);
  }, [pending, index]);
  const byColumn = useMemo(() => {
    const columns = new Map<BoardColumn, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
    for (const t of tickets) columns.get(boardColumn(pending[t.id] ? { ...t, status: pending[t.id].becomes } : t))!.push(t);
    for (const list of columns.values()) list.sort(byArrival);
    return columns;
  }, [tickets, pending]);
  const layoutKey = COLUMNS.map((c) => `${c.id}:${byColumn.get(c.id)!.map((t) => t.id).join(",")}`).join(";");
  const { register, onScroll } = useBoardAnimation(layoutKey);
  const [arrivals, setArrivals] = useState({ tickets, loaded: projectLoaded, entering: new Set<string>() });
  if (tickets !== arrivals.tickets || projectLoaded !== arrivals.loaded) {
    const oldIds = new Set(arrivals.tickets.map((t) => t.id));
    setArrivals({ tickets, loaded: projectLoaded, entering: new Set(arrivals.loaded
      ? tickets.filter((t) => !oldIds.has(t.id)).map((t) => t.id) : []) });
  }
  const entering = arrivals.entering;
  const doneRef = useRef<HTMLDivElement>(null);
  const doneAtBottom = useRef(true);
  const doneIds = useRef<Set<string> | null>(null);
  const doneKey = byColumn.get("done")!.map((t) => t.id).join(",");
  useEffect(() => {
    const ids = doneKey ? doneKey.split(",") : [];
    const arrived = doneIds.current && ids.some((id) => !doneIds.current!.has(id));
    doneIds.current = new Set(ids);
    if (arrived && doneAtBottom.current) doneRef.current?.scrollTo({ top: doneRef.current.scrollHeight, behavior: "smooth" });
  }, [doneKey]);
  return <div className="relative h-full w-full overscroll-x-none" onClick={() => useStore.getState().select(null)}>
    {error && <div role="alert" className="absolute inset-x-2 top-2 z-10 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600" onClick={(e) => e.stopPropagation()}>{error} <button onClick={() => setError(null)}>Dismiss</button></div>}
    <div className="flex h-full gap-2 p-[5px]" onScrollCapture={onScroll}>
      {COLUMNS.map((col) => <div key={col.id} className={`flex min-h-0 w-0 min-w-0 flex-1 flex-col rounded-xl border ${col.tint}`}>
        <div className={`flex items-center justify-between px-3 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide ${col.header}`}>
          <span>{col.title}</span><span className="font-normal opacity-70">{byColumn.get(col.id)!.length}</span>
        </div>
        <div ref={col.id === "done" ? doneRef : undefined}
          onScroll={col.id === "done" ? (e) => {
            const el = e.currentTarget;
            doneAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
          } : undefined}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {byColumn.get(col.id)!.map((t) => <TicketCard key={t.id} t={t} column={col.id}
            worker={t.workerId ? workerById.get(t.workerId) : undefined}
            busy={index.workerBusyOn(t.id)} claimsForTicket={index.fileHolders(t.id)}
            blockeesForTicket={index.fileBlockees(t.id)} entering={entering.has(t.id)} register={register} hold={hold} onError={setError} />)}
        </div>
      </div>)}
    </div>
  </div>;
}
