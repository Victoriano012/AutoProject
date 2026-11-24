import type { Attachment, Project, Ticket, Worker } from "../types";

export function inheritedAttachments(project: Project, ticket: Ticket): Attachment[] {
  return [...(project.attachments ?? []), ...(ticket.attachments ?? [])];
}

export const workerOf = (project: Project, ticket: Ticket): Worker | undefined =>
  project.workers.find((w) => w.id === ticket.workerId);

/** Measured on this board: tickets that began on a conversation of 120k+
 * tokens compacted mid-run (the window is pinned to 200k) and drew the
 * rejections; each finished ticket adds ~25k. Starting under 60k leaves a
 * ticket 100k+ of room. */
export const FRESH_AFTER_TOKENS = 60_000;
export const FRESH_AFTER_TICKETS = 4;

/** The worker conversation a ticket starting now continues, or undefined for
 * a new one: none yet, or the old one has grown too big to be worth re-reading. */
export function startingSession(project: Project, ticket: Ticket): string | undefined {
  const worker = workerOf(project, ticket);
  if (!worker?.sessionId) return undefined;
  const done = project.tickets.filter(
    (t) => t.workerId === worker.id && t.id !== ticket.id && t.sessionId === worker.sessionId
  ).length;
  return (worker.contextTokens ?? 0) >= FRESH_AFTER_TOKENS || done >= FRESH_AFTER_TICKETS
    ? undefined
    : worker.sessionId;
}

/** A new conversation's short memory of the worker's finished tickets. */
function earlierWork(project: Project, worker: Worker, ticket: Ticket): string | undefined {
  const lines = project.tickets
    .filter((t) => t.workerId === worker.id && t.id !== ticket.id && (t.status === "done" || t.status === "review"))
    .sort((a, b) => (a.statusChangedAt ?? 0) - (b.statusChangedAt ?? 0))
    .slice(-6)
    .map((t) => {
      const gist = (t.resultSummary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 200);
      return `- ${t.title}${gist ? `: ${gist}` : ""}`;
    });
  return lines.length ? `Your earlier tickets, already in the workspace:\n${lines.join("\n")}` : undefined;
}

/** What a ticket's agent is told. Pure, so tests can read it. `fresh`: the
 * conversation turned out to be gone, whatever the worker says. */
export function ticketPrompt(project: Project, ticket: Ticket, fresh = false): string {
  const worker = workerOf(project, ticket);
  const resumed = !fresh && startingSession(project, ticket) !== undefined;
  const lines = [
    `You are an autonomous engineer working on the project "${project.name}" inside the current working directory. Do the work described by the ticket below directly in this directory.`,
    // A resumed conversation has the worker's earlier tickets in it; a new one
    // gets their gist instead.
    worker &&
      `You are worker #${worker.n} (${worker.description}).` +
        (resumed ? " Earlier tickets in this conversation are done; this is a new ticket." : ""),
    worker && !resumed && earlierWork(project, worker, ticket),
    project.description && `\nProject description:\n${project.description}`,
    project.notes.length > 0 &&
      `\nStanding instructions for this project (always apply):\n` +
        project.notes.map((n) => `- ${n}`).join("\n"),
    `\n## Ticket: ${ticket.title}\n${ticket.description || "(no further description)"}`,
    `\nA human will review this ticket when you finish. If the workspace is a git repository, commit your work when done (one commit, message = ticket title). End your reply with (1) a 2-4 sentence summary of what you did and (2) a short checklist of what the human should test.`,
  ];
  return lines.filter(Boolean).join("\n");
}
