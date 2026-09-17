import type { Project, Ticket } from "./types";

/**
 * Single-writer discipline between the browser and the server process.
 *
 * Runs execute in the server, so the server is the only writer of the fields a
 * run produces — status, log, sessionId, resultSummary, stats — and, since the
 * project agent adds and removes tickets there too, of the ticket set itself,
 * of the workers it assigns them to and of its own conversation. The browser
 * is the only writer of the user fields (titles, descriptions, files,
 * attachments, paused, notes).
 *
 * Autosaves send field comparisons through project-edits.ts. This merge is
 * used only to preserve newer streamed run state across a save acknowledgement.
 */

/** Run-produced fields, present on the ticket only when set. */
function runFields(t: Ticket): Partial<Ticket> {
  return {
    status: t.status,
    log: t.log,
    statusChangedAt: t.statusChangedAt,
    workerId: t.workerId,
    sessionId: t.sessionId,
    resultSummary: t.resultSummary,
    stats: t.stats,
  };
}

/** Server-owned project-level fields. */
function projectRunFields(p: Project): Partial<Project> {
  return {
    chat: p.chat,
    workers: p.workers,
    agentSessionId: p.agentSessionId,
    revision: p.revision,
    pendingFeedback: p.pendingFeedback,
    agentRequests: p.agentRequests,
  };
}

/** Ticket set and run fields from `run` (the server); user fields from `edit`
 * where the browser knows the ticket. */
export function mergeRunState(edit: Project, run: Project): Project {
  const edited = new Map(edit.tickets.map((t) => [t.id, t]));
  const known = new Set(run.tickets.map((t) => t.id));
  const tickets = run.tickets.map((r) => {
    const e = edited.get(r.id);
    return e ? { ...e, ...runFields(r) } : r;
  });
  if (process.env.NODE_ENV !== "production") {
    // A ticket only the browser knows is one the server has since removed (or
    // never had): a stale tab. Its edits are dropped, which is worth knowing.
    const unknown = edit.tickets.filter((t) => !known.has(t.id));
    if (unknown.length > 0) {
      console.warn(
        `mergeRunState dropped ${unknown.length} ticket(s) the server does not know: ` +
          unknown.map((t) => t.id).join(", ")
      );
    }
  }
  return { ...edit, ...projectRunFields(run), tickets };
}
