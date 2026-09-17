"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  approveTicket,
  noteTicket,
  rejectTicket,
  removeTickets,
  runTicket,
  stopTicket,
} from "@/lib/runner";
import { useStore } from "@/lib/store";
import ConfirmDialog from "./ConfirmDialog";
import { LogView } from "./LogView";
import { HandIcon, NoteIcon, Spinner, StopSquare } from "./icons";
import {
  BoardColumn,
  boardColumn,
  byArrival,
  fileBlockees,
  fileClaims,
  Ticket,
  TicketStatus,
  workerBusyOn,
} from "@/lib/types";

type ColumnId = BoardColumn;

const COLUMNS: {
  id: ColumnId;
  title: string;
  tint: string;
  header: string;
}[] = [
  {
    id: "blocked",
    title: "Blocked",
    tint: "border-zinc-200 bg-zinc-100/70",
    header: "text-zinc-500",
  },
  {
    id: "working",
    title: "Working",
    tint: "border-blue-200 bg-blue-50",
    header: "text-blue-600",
  },
  {
    id: "review",
    title: "Ready for review",
    tint: "border-yellow-200 bg-yellow-50",
    header: "text-yellow-700",
  },
  {
    id: "done",
    title: "Done",
    tint: "border-emerald-200 bg-emerald-50",
    header: "text-emerald-700",
  },
];

/** 10 lines of text-xs (16px line-height) + py-1 (8px) + 2px border. */
const COMPOSER_MAX_HEIGHT = 170;

/** Sent to the agent when a card is rejected with nothing typed. */
const DEFAULT_REJECTION =
  "This isn't finished. Go back over the work, find what is missing or wrong, and complete it properly.";

/** An extra indication becomes part of the ticket, not a message in the air:
 * it is what the card's next run reads, it survives a reload, and the person
 * can see (and edit) it on the card. */
const withIndication = (description: string, note: string) =>
  `${description.trimEnd()}\n\nExtra indication from the human: ${note}`.trim();

/** The box a card opens for a message to its agent — the review column's ✕ and
 * the note button on a card in flight both use this one. Grows with the text up
 * to ten lines and then scrolls; Enter sends, Shift+Enter is a newline, and
 * Escape or a press anywhere outside closes it with the draft intact. */
function CardComposer({
  value,
  onChange,
  onSend,
  onClose,
  placeholder,
  tone,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  placeholder: string;
  tone: "reject" | "note";
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skin =
    tone === "reject"
      ? {
          border: "border-red-300 focus:border-red-400",
          send: "bg-red-500 hover:bg-red-400",
        }
      : {
          border: "border-violet-300 focus:border-violet-400",
          send: "bg-violet-500 hover:bg-violet-400",
        };

  // The box mounts fresh on every open, so a restored multi-line draft comes
  // back at the height it had — same growth as ChatInput.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto"; // shrink so scrollHeight reflects the content
    const h = Math.min(el.scrollHeight + 2, COMPOSER_MAX_HEIGHT);
    el.style.height = `${h}px`;
    el.style.overflowY = h >= COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  return (
    // items-end: Send sits level with the last line of a grown box.
    <div ref={boxRef} className="flex items-end gap-1.5">
      <textarea
        autoFocus
        ref={inputRef}
        rows={1}
        className={`block min-w-0 flex-1 resize-none rounded-md border bg-white px-2 py-1 text-xs outline-none ${skin.border}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <button
        className={`rounded-md px-2 py-1 text-xs text-white ${skin.send}`}
        onClick={onSend}
      >
        Send
      </button>
    </div>
  );
}

/** Jira-like kanban view over the project's tickets. The columns are a pure
 * function of ordinary ticket statuses, so the runner drives every card move;
 * the ticket set itself is the server's (the project agent adds cards, the
 * runs API deletes them), so this view never writes it. */
export default function BoardView() {
  const project = useStore((s) => s.project);
  const projectId = useStore((s) => s.projectId);
  const projectLoaded = useStore((s) => s.projectLoaded);
  // Pressing a card opens its agent conversation; the store remembers which
  // one across a reload.
  const selectedId = useStore((s) => s.selectedId);
  const { updateTicket, select } = useStore.getState();
  const tickets = project.tickets;

  const [confirmDelete, setConfirmDelete] = useState<Ticket | null>(null);
  /** The card whose worker badge was pressed: it shows the worker's description. */
  const [workerShown, setWorkerShown] = useState<string | null>(null);
  const workerOf = (t: Ticket) => project.workers.find((w) => w.id === t.workerId);

  // ---- grow-in for cards that have just turned up ----
  // The board seeds itself with whatever it opens with, so nothing animates on
  // load or when a project opens; only an id it has never drawn grows in — the
  // project agent's tickets landing mid-turn included. The id stops being new
  // once the animation is over, because a column move remounts the card and
  // would otherwise replay it.
  const seenIds = useRef(new Set<string>());
  const seededFor = useRef<string | null>(null);
  const enteringIds = useRef(new Set<string>());
  if (projectLoaded) {
    if (seededFor.current !== projectId) {
      // First render of this project (or of another one): seed, don't animate.
      seededFor.current = projectId;
      seenIds.current = new Set(tickets.map((t) => t.id));
    } else {
      for (const t of tickets) {
        if (seenIds.current.has(t.id)) continue;
        seenIds.current.add(t.id);
        enteringIds.current.add(t.id);
        setTimeout(() => enteringIds.current.delete(t.id), 400);
      }
    }
  }

  // ---- Done column: follow new arrivals ----
  const doneListRef = useRef<HTMLDivElement>(null);
  const doneIds = useRef(new Set<string>());
  const doneSeeded = useRef(false);
  const doneAtBottom = useRef(true);

  // ---- the two boxes a card can open: reject (✕ in review) and note ----
  // One at a time on the whole board, so opening either closes the other.
  const [openBox, setOpenBox] = useState<{ id: string; kind: "reject" | "note" } | null>(
    null
  );
  const boxOn = (kind: "reject" | "note", id: string) =>
    openBox?.kind === kind && openBox.id === id;
  const closeBox = () => setOpenBox(null);
  // Drafts outlive the input: one per ticket, dropped only when the person
  // empties the box themselves or the message is actually sent.
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  /** Where a sent note has got to, on the card: in flight, then its outcome. */
  const [noteFlash, setNoteFlash] = useState<
    Record<string, { text: string; className: string }>
  >({});
  // One line per card, so a line that clears itself must not outlive the note
  // it belongs to: a second note takes the line over, timer and all.
  const noteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  function flashNote(
    id: string,
    flash: { text: string; className: string } | null,
    clearAfter?: number
  ) {
    clearTimeout(noteTimers.current.get(id));
    noteTimers.current.delete(id);
    setNoteFlash((f) => {
      const next = { ...f };
      if (flash) next[id] = flash;
      else delete next[id];
      return next;
    });
    if (flash && clearAfter) {
      noteTimers.current.set(
        id,
        setTimeout(() => flashNote(id, null), clearAfter)
      );
    }
  }
  /** Which note owns a card's line: an earlier one that lands late has nothing
   * left to say, and saying it would strand its wording over a newer note. */
  const noteSeq = useRef(new Map<string, number>());
  /** The ✓ and ✕ the server has not answered yet: ticket id → the status the
   * person's answer will give it, the status it had when they gave it, and
   * when. Both answers are the person's own decision, so the card leaves review
   * on the click and the round-trip only confirms it. */
  const [pending, setPending] = useState<
    Record<string, { becomes: TicketStatus; was: TicketStatus; at: number }>
  >({});
  const hold = (t: Ticket, becomes: TicketStatus) =>
    setPending((p) => ({ ...p, [t.id]: { becomes, was: t.status, at: Date.now() } }));

  // A hold lasts exactly until the truth arrives — the card's status moves off
  // the one it was answered in — and no longer than a few seconds regardless,
  // so an answer that never reaches the server leaves the card where the
  // server really has it rather than pinned in the wrong column.
  useEffect(() => {
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    const drop = (stale: string[]) => {
      if (stale.length === 0) return;
      setPending((p) => {
        const next = { ...p };
        for (const id of stale) delete next[id];
        return next;
      });
    };
    drop(
      ids.filter((id) => {
        const t = tickets.find((x) => x.id === id);
        return !t || t.status !== pending[id].was;
      })
    );
    const timer = setTimeout(
      () => drop(ids.filter((id) => Date.now() - pending[id].at > 10_000)),
      10_000
    );
    return () => clearTimeout(timer);
  }, [pending, tickets]);

  /** Stop the agent and keep the ticket out of the queue until the person
   * starts it again. The flag is the browser's own field, so it outlives the
   * reload the server's stop does not know about. */
  const stopping = useRef(new Set<string>());
  function pause(ticketId: string) {
    stopTicket(ticketId);
    // The agent takes a moment to wind down: until its status leaves "running"
    // the ticket is stopping, not started again.
    stopping.current.add(ticketId);
    updateTicket(ticketId, (t) => ({ ...t, paused: true }));
  }

  // A pause only means anything while the ticket waits in the queue. Once it is
  // running again — the board's Run button, or a project run, which
  // deliberately lifts stops — or the agent has carried it on to review, the
  // pause is over.
  useEffect(() => {
    for (const t of tickets) {
      if (t.status !== "running") stopping.current.delete(t.id);
      if (t.paused && t.status !== "todo" && !stopping.current.has(t.id))
        updateTicket(t.id, (x) => ({ ...x, paused: false }));
    }
  });

  function resume(ticketId: string) {
    updateTicket(ticketId, (t) => ({ ...t, paused: false }));
    void runTicket(ticketId);
  }

  /**
   * An extra indication for a card that has not reached review: it goes into
   * the ticket (so the card's next run reads it, and it survives a reload) and
   * to the server, which hands it to the agent right now if one is at work on
   * this card — and never starts a card that is standing still.
   */
  function submitNote(t: Ticket) {
    const msg = (noteDrafts[t.id] ?? "").trim();
    if (!msg) return; // nothing typed: no default here, unlike a rejection
    closeBox();
    setNoteDrafts((d) => ({ ...d, [t.id]: "" }));
    updateTicket(t.id, (x) => ({
      ...x,
      description: withIndication(x.description, msg),
    }));
    const live = t.status === "running";
    const mine = (noteSeq.current.get(t.id) ?? 0) + 1;
    noteSeq.current.set(t.id, mine);
    // The card says "Sending…" for exactly as long as that is true, and then
    // only what is still worth saying: a working card's agent has the
    // indication, so the line goes and leaves the card as it was.
    flashNote(t.id, { text: "Sending…", className: "text-zinc-400" });
    // The flush inside this call is what carries the description above to the
    // server, so a card that starts a moment later already has the indication.
    void noteTicket(t.id, msg).then((sent) => {
      if (noteSeq.current.get(t.id) !== mine) return;
      if (!sent) {
        flashNote(t.id, { text: "Not sent — send it again", className: "text-red-500" });
      } else if (live) {
        flashNote(t.id, null);
      } else {
        flashNote(
          t.id,
          {
            text: "Saved — the agent gets it when it starts",
            className: "text-violet-500",
          },
          8000
        );
      }
    });
  }

  function submitReject(t: Ticket) {
    const msg = (rejectDrafts[t.id] ?? "").trim() || DEFAULT_REJECTION;
    closeBox();
    setRejectDrafts((d) => ({ ...d, [t.id]: "" }));
    // Back to its agent: Working, or Blocked if another card holds its file.
    hold(t, "todo");
    void rejectTicket(t.id, msg).catch(() =>
      // The rejection never reached the server: the card is still the person's.
      setPending((p) => {
        const next = { ...p };
        delete next[t.id];
        return next;
      })
    );
  }

  /** The ✓: the person has signed the card off, so it is Done from this click. */
  function submitApprove(t: Ticket) {
    hold(t, "done");
    approveTicket(t.id);
  }

  // ---- FLIP column-move animation ----
  const boardRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const skipFlipRef = useRef(false);
  const [, setMeasureTick] = useState(0);

  useEffect(() => {
    const onResize = () => {
      skipFlipRef.current = true;
      setMeasureTick((t) => t + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (!boardRef.current) return;

    // FLIP: cards keyed by ticket id — a card that changed column is a new
    // DOM node, but the delta from its previous rect still animates it
    // continuously from where it was. The measured element is the wrapper and
    // the animation runs on the card inside it, so a rect read here is always
    // the card's settled position: measuring an animating element would report
    // where it came from and animate the opposite delta on the next render.
    const next = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) {
      if (el.isConnected) next.set(id, el.getBoundingClientRect());
    }
    if (!skipFlipRef.current) {
      for (const [id, rect] of next) {
        const old = prevRects.current.get(id);
        if (!old) continue;
        const dx = old.left - rect.left;
        const dy = old.top - rect.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          (cardRefs.current.get(id)!.firstElementChild as HTMLElement).animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 300, easing: "ease" }
          );
        }
      }
    }
    skipFlipRef.current = false;
    prevRects.current = next;
  });

  // File contention, straight off the helpers so the board says exactly what
  // the scheduler does: who waits on a file, and who is holding one.
  const claimsOf = (t: Ticket) => fileClaims(tickets, t.id);
  const blockeesOf = (t: Ticket) => fileBlockees(tickets, t.id);

  /**
   * One line per file. The helpers answer per card, so two cards holding the
   * same file are two answers about one file — on the card that is what a
   * person reads as the same thing said twice. The line is the file name and
   * nothing else; which cards, and every file they share, is the hover.
   */
  const fileLines = (
    rows: { file: string; files: string[]; who: Ticket }[],
    say: (files: string[], names: string[]) => string
  ) => {
    const byFile = new Map<string, { files: Set<string>; names: string[] }>();
    for (const r of rows) {
      const cur = byFile.get(r.file) ?? { files: new Set<string>(), names: [] };
      for (const f of r.files) cur.files.add(f);
      if (!cur.names.includes(r.who.title)) cur.names.push(r.who.title);
      byFile.set(r.file, cur);
    }
    return [...byFile].map(([file, v]) => ({
      file,
      hover: say([...v.files], v.names),
    }));
  };

  const byColumn = new Map<ColumnId, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
  for (const t of tickets) {
    // A card whose ✓ or ✕ is still on its way to the server is placed as the
    // status it is about to have, so it leaves review on the click rather than
    // a round-trip later.
    const p = pending[t.id];
    const asked = p ? { ...t, status: p.becomes } : t;
    byColumn.get(boardColumn(asked))!.push(t);
  }
  // Earliest arrival in the column first, so a card that just moved lands at
  // the bottom rather than shuffling the ones already there.
  for (const list of byColumn.values()) list.sort(byArrival);
  // The four columns are the whole board: every card is in exactly one of them,
  // so a card that renders nowhere is a bug and not a state to discover from a
  // person telling you their tickets disappeared.
  if (process.env.NODE_ENV !== "production") {
    const placed = COLUMNS.reduce((n, c) => n + byColumn.get(c.id)!.length, 0);
    if (placed !== tickets.length)
      console.error(`BoardView: ${tickets.length} cards, ${placed} placed in columns`);
  }
  const doneKey = byColumn
    .get("done")!
    .map((t) => t.id)
    .join(",");

  // A card landing in Done scrolls the column down to it — but only if the
  // person was already at the bottom, so scrolling up to read something older
  // is never yanked away. `doneAtBottom` tracks their last scroll, not the
  // current geometry, which drifts as the column grows.
  useEffect(() => {
    const ids = doneKey ? doneKey.split(",") : [];
    const arrived =
      doneSeeded.current && ids.some((id) => !doneIds.current.has(id));
    doneIds.current = new Set(ids);
    doneSeeded.current = true;
    const el = doneListRef.current;
    if (!el) return;
    if (arrived && doneAtBottom.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    // Nothing arrived, so this geometry is the person's own position — the
    // reading the next arrival is judged against. (Once a card lands, the
    // column has already grown and it is too late to ask.)
    doneAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }, [doneKey]);

  const cardRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  /** Say something more to this card's agent — on the two columns where the
   * work is still in front of it, so nobody has to wait for review to get a
   * word in. Quiet: it sits with the card's other affordances. */
  const noteButton = (t: Ticket) => (
    <button
      type="button"
      title="Add an indication for this card's agent"
      className="shrink-0 text-zinc-400 hover:text-violet-600"
      onClick={(e) => {
        e.stopPropagation();
        setOpenBox({ id: t.id, kind: "note" });
      }}
    >
      <NoteIcon />
    </button>
  );

  return (
    // Cards stop this click, so anything else — column background, headers,
    // the footer button — lands here and clears the selection while still
    // doing whatever it does itself.
    <div className="h-full w-full overscroll-x-none" onClick={() => select(null)}>
      {/* columns; p-[5px]: flush inside the page's frame, matching the bottom
        * bar's margins under it */}
      <div
        ref={boardRef}
        className="flex h-full gap-2 p-[5px]"
        onScrollCapture={() => {
          skipFlipRef.current = true;
          setMeasureTick((t) => t + 1);
        }}
      >
        {COLUMNS.map((col) => (
          <div
            key={col.id}
            // min-w-0: without it a flex child never shrinks below its content,
            // so one long title would widen its column and squeeze the others.
            // The four columns are always a quarter of the board each.
            className={`flex min-h-0 w-0 min-w-0 flex-1 flex-col rounded-xl border ${col.tint}`}
          >
            <div
              className={`flex items-center justify-between px-3 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide ${col.header}`}
            >
              <span>{col.title}</span>
              <span className="font-normal opacity-70">
                {byColumn.get(col.id)!.length}
              </span>
            </div>
            <div
              ref={col.id === "done" ? doneListRef : undefined}
              onScroll={
                col.id === "done"
                  ? (e) => {
                      const el = e.currentTarget;
                      doneAtBottom.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                    }
                  : undefined
              }
              className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
            >
              {byColumn.get(col.id)!.map((t) => {
                // Files this card waits for, and files it holds that somebody
                // else waits for. Both lists sit in the card's bottom-left, with
                // the card's own control right-aligned on the last of them.
                const claims = fileLines(
                  claimsOf(t).map((c) => ({ file: c.file, files: c.files, who: c.by })),
                  (files, names) =>
                    `Waiting for ${files.join(", ")}, held by ${names.join(", ")}`
                );
                const heldLines = fileLines(
                  blockeesOf(t).map((b) => ({ file: b.file, files: b.files, who: b.who })),
                  (files, names) =>
                    `${names.join(", ")} ${
                      names.length > 1 ? "are" : "is"
                    } waiting for ${files.join(", ")}`
                ).map((r) => (
                  <div
                    key={r.file}
                    title={r.hover}
                    className="flex min-w-0 items-center gap-1 text-zinc-400"
                  >
                    <HandIcon />
                    <span className="truncate">{r.file}</span>
                  </div>
                ));
                const worker = workerOf(t);
                const busy = workerBusyOn(tickets, t.id);
                return (
                // The wrapper is what the effect above measures; the card
                // inside it is what the FLIP animation moves.
                <div key={t.id} ref={cardRef(t.id)}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      select(selectedId === t.id ? null : t.id);
                    }}
                    className={`relative cursor-pointer rounded-xl border bg-white p-3 shadow-sm hover:shadow ${
                      enteringIds.current.has(t.id) ? "ticket-appear " : ""
                    }${
                      t.id === selectedId
                        ? "border-violet-500"
                        : t.status === "error"
                          ? "border-red-300"
                          : "border-zinc-200"
                    }`}
                  >
                    <button
                      className="absolute right-2 top-1.5 text-sm leading-none text-zinc-400 hover:text-red-500"
                      title="Delete ticket"
                      aria-label="Delete ticket"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(t);
                      }}
                    >
                      ×
                    </button>
                    {worker && (
                      // Which worker runs this card; pressing it says what that
                      // worker is for.
                      <button
                        className="absolute right-2 top-6 font-mono text-[10px] leading-none text-zinc-400 hover:text-zinc-900"
                        title="Worker — press to see what it is assigned"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWorkerShown(workerShown === t.id ? null : t.id);
                        }}
                      >
                        #{worker.n}
                      </button>
                    )}
                    <div className="line-clamp-2 break-words pr-4 text-sm font-medium text-zinc-900">
                      {t.title}
                    </div>
                    {worker && workerShown === t.id && (
                      <div className="mt-1 text-[11px] text-zinc-500">
                        <span className="font-mono">#{worker.n}</span> {worker.description}
                      </div>
                    )}
                    {/* The pressed card shows what its agent has been doing —
                     * not the description, which is what the person wrote. */}
                    {t.id === selectedId && <LogView entries={t.log ?? []} />}

                    {col.id === "blocked" && (
                      // Every reason this card is not moving, stacked; the way
                      // back out (paused only) sits on the last of them.
                      <div className="mt-2 flex items-end justify-between gap-2 text-[11px]">
                        <div className="min-w-0 space-y-0.5 text-zinc-400">
                          {t.paused && (
                            <div>{t.status === "running" ? "Stopping…" : "Paused"}</div>
                          )}
                          {claims.map((c) => (
                            <div key={c.file} className="truncate" title={c.hover}>
                              ⛔ {c.file}
                            </div>
                          ))}
                          {busy && worker && (
                            <div
                              className="truncate"
                              title={`Worker #${worker.n} is still on “${busy.title}”`}
                            >
                              ⛔ #{worker.n} on “{busy.title}”
                            </div>
                          )}
                          {heldLines}
                          {noteFlash[t.id] && (
                            <div className={noteFlash[t.id].className}>
                              {noteFlash[t.id].text}
                            </div>
                          )}
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {noteButton(t)}
                          {t.paused && (
                          <button
                            disabled={t.status === "running"}
                            title={t.status === "running" ? "Stopping the agent…" : "Run"}
                            className={`shrink-0 text-sm leading-none ${
                              t.status !== "running"
                                ? "text-emerald-600 hover:text-emerald-500"
                                : "cursor-not-allowed text-zinc-400"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              resume(t.id);
                            }}
                          >
                            ▶
                          </button>
                          )}
                        </div>
                      </div>
                    )}

                    {col.id === "working" && (
                      // The spinner alone says the agent is on it; stop sits
                      // beside it, on the right where the eye already is.
                      <div className="mt-2 flex items-end justify-between gap-2 text-[11px]">
                        <div className="min-w-0 space-y-0.5">
                          {t.status === "error" ? (
                            <div className="text-red-500">Failed</div>
                          ) : t.status === "running" ? null : (
                            <div className="text-blue-500/80">Queued</div>
                          )}
                          {heldLines}
                          {noteFlash[t.id] && (
                            <div className={noteFlash[t.id].className}>
                              {noteFlash[t.id].text}
                            </div>
                          )}
                        </div>
                        <div
                          className="flex shrink-0 items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {noteButton(t)}
                          {t.status === "running" ? (
                            <>
                              <StopSquare onClick={() => pause(t.id)} />
                              <Spinner className="h-2.5 w-2.5" />
                            </>
                          ) : t.status === "error" ? (
                            <button
                              className="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-700 hover:bg-zinc-200"
                              onClick={() => void runTicket(t.id)}
                            >
                              ↻ Retry
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )}

                    {/* The note box, on the two columns whose work is still to
                     * come. Same box the ✕ opens in review. */}
                    {(col.id === "blocked" || col.id === "working") &&
                      boxOn("note", t.id) && (
                        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                          <CardComposer
                            value={noteDrafts[t.id] ?? ""}
                            onChange={(v) =>
                              setNoteDrafts((d) => ({ ...d, [t.id]: v }))
                            }
                            onSend={() => submitNote(t)}
                            onClose={closeBox}
                            placeholder="More indications for the agent…"
                            tone="note"
                          />
                        </div>
                      )}

                    {col.id === "review" && (
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        {boxOn("reject", t.id) ? (
                          <CardComposer
                            value={rejectDrafts[t.id] ?? ""}
                            onChange={(v) =>
                              setRejectDrafts((d) => ({ ...d, [t.id]: v }))
                            }
                            onSend={() => submitReject(t)}
                            onClose={closeBox}
                            placeholder="What's wrong?"
                            tone="reject"
                          />
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              className="flex-1 rounded-md bg-emerald-100 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200"
                              title="Approve — mark done"
                              onClick={() => submitApprove(t)}
                            >
                              ✓
                            </button>
                            <button
                              className="flex-1 rounded-md bg-red-100 py-1 text-xs font-medium text-red-600 hover:bg-red-200"
                              title="Reject — describe what's wrong"
                              onClick={() => setOpenBox({ id: t.id, kind: "reject" })}
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete ticket?"
          message={`“${confirmDelete.title}” will be removed from the board.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            void removeTickets([confirmDelete.id]);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
