import type { Attachment, Project, Ticket, Worker } from "../types";

export function inheritedAttachments(project: Project, ticket: Ticket): Attachment[] {
  return [...(project.attachments ?? []), ...(ticket.attachments ?? [])];
}

export const workerOf = (project: Project, ticket: Ticket): Worker | undefined =>
  project.workers.find((w) => w.id === ticket.workerId);

/** What a ticket's agent is told. Pure, so tests can read it. */
export function ticketPrompt(project: Project, ticket: Ticket): string {
  const worker = workerOf(project, ticket);
  const lines = [
    `You are an autonomous engineer working on the project "${project.name}" inside the current working directory. Do the work described by the ticket below directly in this directory.`,
    // A worker with a session has this conversation's earlier tickets in it.
    worker &&
      `You are worker #${worker.n} (${worker.description}).` +
        (worker.sessionId
          ? " Earlier tickets in this conversation are done; this is a new ticket."
          : ""),
    project.description && `\nProject description:\n${project.description}`,
    project.notes.length > 0 &&
      `\nStanding instructions for this project (always apply):\n` +
        project.notes.map((n) => `- ${n}`).join("\n"),
    `\n## Ticket: ${ticket.title}\n${ticket.description || "(no further description)"}`,
    `\nA human will review this ticket when you finish. If the workspace is a git repository, commit your work when done (one commit, message = ticket title). End your reply with (1) a 2-4 sentence summary of what you did and (2) a short checklist of what the human should test.`,
  ];
  return lines.filter(Boolean).join("\n");
}
