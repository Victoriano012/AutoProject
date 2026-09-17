import { useEffect, useMemo, useRef, useState } from "react";
import { approveTicket, noteTicket, rejectTicket, runTicket, stopTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { Ticket, TicketStatus } from "@/lib/types";

/** Sent to the agent when a card is rejected with nothing typed. */
const DEFAULT_REJECTION =
  "This isn't finished. Go back over the work, find what is missing or wrong, and complete it properly.";

/** An extra indication becomes part of the ticket, not a message in the air:
 * it is what the card's next run reads, it survives a reload, and the person
 * can see (and edit) it on the card. */
const withIndication = (description: string, note: string) =>
  `${description.trimEnd()}\n\nExtra indication from the human: ${note}`.trim();

export function useTicketActions(t: Ticket, hold: (t: Ticket, status: TicketStatus | null) => void, onError: (message: string) => void) {
  const { updateTicket } = useStore.getState();
  const tickets = useMemo(() => [t], [t]);
  const reportError = (err: unknown) => onError(err instanceof Error ? err.message : String(err));
  const [openBox, setOpenBox] = useState<{ id: string; kind: "reject" | "note" } | null>(
    null
  );
  const boxOn = (kind: "reject" | "note", id: string) =>
    openBox?.kind === kind && openBox.id === id;
  const closeBox = () => setOpenBox(null);
  // Drafts outlive the input: one per ticket, dropped only when the person
  // empties the box themselves or the message is actually sent.
  const [rejectDraft, setRejectDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  /** Where a sent note has got to, on the card: in flight, then its outcome. */
  const [noteFlash, setNoteFlash] = useState<
    Record<string, { text: string; className: string }>
  >({});
  // One line per card, so a line that clears itself must not outlive the note
  // it belongs to: a second note takes the line over, timer and all.
  const noteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = noteTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); };
  }, []);
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
  /** Stop the agent and keep the ticket out of the queue until the person
   * starts it again. The flag is the browser's own field, so it outlives the
   * reload the server's stop does not know about. */
  const stopping = useRef(new Set<string>());
  function pause(ticketId: string) {
    void stopTicket(ticketId).catch(reportError);
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
  }, [tickets, updateTicket]);

  function resume(ticketId: string) {
    updateTicket(ticketId, (t) => ({ ...t, paused: false }));
    void runTicket(ticketId).catch(reportError);
  }

  /**
   * An extra indication for a card that has not reached review: it goes into
   * the ticket (so the card's next run reads it, and it survives a reload) and
   * to the server, which hands it to the agent right now if one is at work on
   * this card — and never starts a card that is standing still.
   */
  function submitNote(t: Ticket) {
    const msg = noteDraft.trim();
    if (!msg) return; // nothing typed: no default here, unlike a rejection
    closeBox();
    setNoteDraft("");
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
        setNoteDraft(msg);
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
    }).catch(reportError);
  }

  function submitReject(t: Ticket) {
    const msg = rejectDraft.trim() || DEFAULT_REJECTION;
    closeBox();
    setRejectDraft("");
    // Back to its agent: Working, or Blocked if another card holds its file.
    hold(t, "todo");
    void rejectTicket(t.id, msg).catch((error) => {
      hold(t, null);
      onError(error instanceof Error ? error.message : String(error));
    });
  }

  /** The ✓: the person has signed the card off, so it is Done from this click. */
  function submitApprove(t: Ticket) {
    hold(t, "done");
    void approveTicket(t.id).catch((error) => {
      hold(t, null);
      onError(error instanceof Error ? error.message : String(error));
    });
  }

  return { boxOn, closeBox, setOpenBox, rejectDraft, setRejectDraft, noteDraft, setNoteDraft,
    noteFlash, pause, resume, submitNote, submitReject, submitApprove };
}
