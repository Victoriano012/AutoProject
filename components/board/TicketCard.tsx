import { memo, useCallback, useState } from "react";
import { removeTickets, runTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { BoardColumn, FileClaim, Ticket, TicketStatus, Worker } from "@/lib/types";
import type { FileBlockee } from "@/lib/board-index";
import ConfirmDialog from "../ConfirmDialog";
import { LogView } from "../LogView";
import { HandIcon, NoteIcon, Spinner, StopSquare } from "../icons";
import CardComposer from "./CardComposer";
import { useTicketActions } from "./useTicketActions";

const EMPTY_LOG: Ticket["log"] = [];
function CardLog({ id }: { id: string }) {
  const entries = useStore((s) => s.project.tickets.find((t) => t.id === id)?.log ?? EMPTY_LOG);
  return <LogView entries={entries} ticketId={id} />;
}

const fileLines = (
  rows: { file: string; files: string[]; who: Ticket }[],
  say: (files: string[], names: string[]) => string
) => {
  const byFile = new Map<string, { files: Set<string>; names: Set<string> }>();
  for (const r of rows) {
    const cur = byFile.get(r.file) ?? { files: new Set<string>(), names: new Set<string>() };
    for (const f of r.files) cur.files.add(f);
    cur.names.add(r.who.title);
    byFile.set(r.file, cur);
  }
  return [...byFile].map(([file, v]) => ({
    file,
    hover: say([...v.files], [...v.names]),
  }));
};

function TicketCard({ t, column, worker, busy, claimsForTicket, blockeesForTicket, entering, register, hold, onError }: {
  t: Ticket;
  column: BoardColumn;
  worker?: Worker;
  busy: Ticket | null;
  claimsForTicket: FileClaim[];
  blockeesForTicket: FileBlockee[];
  entering: boolean;
  register: (id: string, element: HTMLDivElement | null) => void;
  hold: (ticket: Ticket, becomes: TicketStatus | null) => void;
  onError: (message: string) => void;
}) {
  const selected = useStore((s) => s.selectedId === t.id);
  const selectedId = selected ? t.id : null;
  const { select } = useStore.getState();
  const registerCard = useCallback((el: HTMLDivElement | null) => register(t.id, el), [register, t.id]);
  const [confirmDelete, setConfirmDelete] = useState<Ticket | null>(null);
  const [workerShown, setWorkerShown] = useState<string | null>(null);
  const reportError = (err: unknown) => onError(err instanceof Error ? err.message : String(err));
  const { boxOn, closeBox, setOpenBox, rejectDraft, setRejectDraft, noteDraft, setNoteDraft,
    noteFlash, pause, resume, submitNote, submitReject, submitApprove } = useTicketActions(t, hold, onError);

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
  const claims = fileLines(
    claimsForTicket.map((c) => ({ file: c.file, files: c.files, who: c.by })),
    (files, names) =>
      `Waiting for ${files.join(", ")}, held by ${names.join(", ")}`
  );
  const heldLines = fileLines(
    blockeesForTicket.map((b) => ({ file: b.file, files: b.files, who: b.who })),
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
  return (
  // The wrapper is what the effect above measures; the card
  // inside it is what the FLIP animation moves.
  <>
  <div ref={registerCard}>
    <div
      onClick={(e) => {
        e.stopPropagation();
        select(selectedId === t.id ? null : t.id);
      }}
      className={`relative cursor-pointer rounded-xl border bg-white p-3 shadow-sm hover:shadow ${
        entering ? "ticket-appear " : ""
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
      {t.id === selectedId && <CardLog id={t.id} />}

      {column === "blocked" && (
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

      {column === "working" && (
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
                onClick={() => void runTicket(t.id).catch(reportError)}
              >
                ↻ Retry
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* The note box, on the two columns whose work is still to
       * come. Same box the ✕ opens in review. */}
      {(column === "blocked" || column === "working") &&
        boxOn("note", t.id) && (
          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
            <CardComposer
              value={noteDraft}
              onChange={(v) =>
                setNoteDraft(v)
              }
              onSend={() => submitNote(t)}
              onClose={closeBox}
              placeholder="More indications for the agent…"
              tone="note"
            />
          </div>
        )}

      {column === "review" && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          {boxOn("reject", t.id) ? (
            <CardComposer
              value={rejectDraft}
              onChange={(v) =>
                setRejectDraft(v)
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

      {confirmDelete && <ConfirmDialog title="Delete ticket?"
        message={`“${confirmDelete.title}” will be removed from the board.`}
        confirmLabel="Delete" danger onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { void removeTickets([t.id]).catch(reportError); setConfirmDelete(null); }} />}
      </>
  );
}
export default memo(TicketCard);
