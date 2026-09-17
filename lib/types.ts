import { createBoardIndex } from "./board-index";

export type TicketStatus = "todo" | "running" | "review" | "done" | "error";

/** How the person is working with the project agent: planning tickets on the
 * board (panel) or having it do the work directly (act). */
export type Mode = "panel" | "act";

/** One message sent to the project agent, waiting its turn or taking it. The
 * server keeps them in memory (see project-agent.ts); the browser draws the
 * stack under the board. A request that finished cleanly is simply gone. */
export interface AgentRequest {
  id: string;
  mode: Mode;
  text: string;
  state: "queued" | "running" | "error";
  /** Why the turn failed; set with `state: "error"` only. */
  error?: string;
}

/** A subagent the project agent has working for it right now (act mode), from
 * its Agent tool call to that call's result. Lives in server memory only. */
export interface LiveSubagent {
  /** The tool_use id of the Agent call that started it. */
  id: string;
  description: string;
  type?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string; // data:<mediaType>;base64,…
}

export interface LogEntry {
  kind: "text" | "tool" | "user" | "error" | "info";
  text: string;
  ts: number;
}

/**
 * What a ticket's agent work cost, folded in by the server as each session
 * ends. Absent on tickets that never ran and on every ticket of a project
 * older than this field — "not recorded" is not the same as zero, so the stats
 * panel keeps the two apart.
 */
export interface TicketStats {
  /** Agent sessions run for this ticket; feedback and notes resume as another. */
  runs: number;
  /** Wall-clock ms those sessions took. */
  ms: number;
  /** Tokens the provider reported (input + output, cache included). */
  tokens: number;
  /** USD the provider reported. Claude reports one; the Codex CLI never does. */
  costUsd: number;
  /** Runs whose provider reported no cost, so `costUsd` is short by them. */
  runsWithoutCost: number;
  /** Times the person sent this ticket back from review instead of approving. */
  rejections: number;
}

/**
 * One long-lived coding agent. The planner assigns every new ticket to a
 * worker — one whose description covers the ticket's area, or a new one — and
 * all of a worker's tickets run in its one conversation, so it keeps what it
 * learnt doing the last one. Server-owned, like the run fields; never deleted.
 */
export interface Worker {
  id: string;
  /** 1-based and stable: what the cards show and the planner names. */
  n: number;
  /** Its area of the codebase or kind of work, briefly — not any one ticket. */
  description: string;
  /** Its conversation; every ticket assigned to it resumes this. */
  sessionId?: string;
}

/** How the planner names a ticket's worker: an existing one by number, or a
 * new one by description. */
export type WorkerPick = { existing: number } | { new: string };

export interface Ticket {
  id: string;
  title: string;
  description: string;
  /** Workspace-relative paths this ticket expects to touch. Two tickets that
   * share a file are never run at the same time (see `fileBlockedBy`) — file
   * contention is computed from this list, never stored anywhere. */
  files?: string[];
  attachments?: Attachment[];
  /** Stopped by the person: it stays out of the queue and shows a Run button
   * until they start it again. */
  paused?: boolean;
  // ---- run fields (server-owned, see lib/run-state.ts) ----
  status: TicketStatus;
  /** Wall-clock ms when `status` last changed; columns order by it. */
  statusChangedAt?: number;
  /** The worker this ticket runs on (see Worker); absent on tickets from before workers. */
  workerId?: string;
  /** The session its last run was in — its worker's, kept here too so a ticket
   * from before workers still resumes its own on review feedback. */
  sessionId?: string;
  log: LogEntry[];
  resultSummary?: string;
  /** Server-owned run totals; see TicketStats and `runFields`. */
  stats?: TicketStats;
}

/** One line of the project agent's conversation, shared by both modes. */
export interface ChatEntry extends LogEntry {
  mode: Mode;
  /** Set on the "info" entry the planner writes after adding tickets. */
  ticketIds?: string[];
}

export interface Project {
  /** Revision of editable metadata; run/log events do not advance it. */
  revision?: number;
  name: string;
  description: string;
  workspaceDir: string; // where the agent works; empty = server temp dir
  /** Project-wide context files, inherited by every ticket. */
  attachments?: Attachment[];
  /** Where this project's node sits on the meta-graph (project picker). */
  metaPosition?: { x: number; y: number };
  /** Hidden from the meta-graph; importing the folder again clears it. */
  hidden?: boolean;
  /** Standing instructions the project agent extracted; injected into every ticket prompt. */
  notes: string[];
  tickets: Ticket[];
  // ---- run fields (server-owned) ----
  workers: Worker[];
  /** The one project agent's session, resumed every turn in either mode. */
  agentSessionId?: string;
  chat: ChatEntry[];
  /** Durable requests restored after the server restarts. */
  pendingFeedback?: Record<string, string>;
  agentRequests?: AgentRequest[];
}

export const defaultProject = (name: string, workspaceDir = ""): Project => ({
  name,
  description: "",
  workspaceDir,
  attachments: [],
  notes: [],
  tickets: [],
  workers: [],
  chat: [],
});

export function newTicket(partial?: Partial<Ticket>): Ticket {
  return {
    id: crypto.randomUUID(),
    title: "New ticket",
    description: "",
    status: "todo",
    statusChangedAt: Date.now(),
    log: [],
    paused: false,
    ...partial,
  };
}

/** Only the person finishes a ticket: the agent reaching review means there is
 * something to look at, not that the review happened. */
export function isTicketDone(t: Ticket): boolean {
  return t.status === "done";
}

export function isTicketRunning(t: Ticket): boolean {
  return t.status === "running";
}

/** Waiting on a human, not actually running: the agent has handed the ticket
 * over and only a person can move it on. */
export function isTicketWaiting(t: Ticket): boolean {
  return t.status === "review";
}

/**
 * Why this ticket cannot start: another ticket is going to touch one of its
 * files. Two agents must never edit one file at once, so the second ticket
 * waits — computed from the files each ticket declares, never stored.
 *
 * A ticket holds its files only while it is still going to work on them — the
 * Working column, exactly (`boardColumn`), so a card the person sees waiting
 * anywhere else is holding nothing. Once it reaches review the agent has
 * stopped, so the next ticket takes the file without waiting for the person to
 * approve anything. (Sending a ticket in review back with feedback makes it
 * claim its files again, and it then waits its turn like anything else — see
 * `sendFeedback`.)
 */
export interface FileClaim {
  /** The one file shown for this pair — the same on both cards. */
  file: string;
  /** Every file the two tickets share, sorted. */
  files: string[];
  /** The ticket holding them. */
  by: Ticket;
}

/** Where a card sits on its board. The board renders these four columns and
 * the file-contention helpers ask the same question to decide who is holding a
 * file, so the two can never disagree: a card holds its files exactly while
 * the person can see it in Working. */
export type BoardColumn = "blocked" | "working" | "review" | "done";

export function boardColumn(t: Ticket): BoardColumn {
  if (isTicketDone(t)) return "done";
  if (t.status === "review") return "review";
  if (t.status === "running") return "working";
  return "blocked";
}

/** Column order: earliest arrival first, so a newcomer lands at the bottom. */
export function byArrival(a: Ticket, b: Ticket): number {
  return (a.statusChangedAt ?? 0) - (b.statusChangedAt ?? 0);
}

/**
 * Which cards a ticket would collide with if its agent started right now.
 *
 * The physical question, and the one to ask wherever starting the agent is the
 * next thing that happens: two agents in one file is a corrupted working tree
 * whatever else the ticket may also be waiting for.
 */
export function fileHolders(tickets: Ticket[], ticketId: string): FileClaim[] {
  return createBoardIndex(tickets).fileHolders(ticketId);
}

/** Why this ticket is waiting on someone else's file — what a card shows. */
export function fileClaims(tickets: Ticket[], ticketId: string): FileClaim[] {
  return fileHolders(tickets, ticketId);
}

/** The first thing in this ticket's way, or null — the readiness predicate.
 * The callers that gate a run ask this, and the ones that explain a card ask
 * `fileClaims`; they agree because both read `fileHolders`. */
export function fileBlockedBy(
  tickets: Ticket[],
  ticketId: string
): { file: string; by: Ticket } | null {
  return fileHolders(tickets, ticketId)[0] ?? null;
}

/** The mirror of `fileClaims`: the tickets waiting on files this one holds —
 * what a working card shows to say why the rest of the board is waiting. A
 * file nobody else wants is not listed: holding it costs no one anything. */
export function fileBlockees(
  tickets: Ticket[], ticketId: string
): { file: string; files: string[]; who: Ticket }[] {
  return createBoardIndex(tickets).fileBlockees(ticketId);
}

/** The card this ticket's own worker is still on, or null. One worker is one
 * conversation, so two of its tickets can no more run at once than two agents
 * can share a file — and the same rule applies: only a card in Working holds it. */
export function workerBusyOn(tickets: Ticket[], ticketId: string): Ticket | null {
  return createBoardIndex(tickets).workerBusyOn(ticketId);
}

/** True if running the project now could make progress somewhere. Paused,
 * file-blocked and worker-blocked tickets do not count: the scheduler will not
 * dispatch them. */
export function hasRunnableWork(tickets: Ticket[]): boolean {
  const index = createBoardIndex(tickets);
  return tickets.some((t) => t.status === "todo" && !t.paused &&
    index.fileHolders(t.id).length === 0 && !index.workerBusyOn(t.id));
}

/** The one thing only the running server knows, asked as a question so the
 * scheduling rules below stay pure and testable: which tickets the person
 * stopped. */
export interface SchedulerFacts {
  stopped: (ticketId: string) => boolean;
}

/**
 * Why the scheduler will not start this ticket right now, in words, or null
 * when it would. The server's `readyTickets` is exactly the tickets this
 * answers null for — one definition, so "will it run" and "why not" can never
 * drift apart, and the board can be checked against it (see `stuckCards`).
 */
export function notReadyReason(
  tickets: Ticket[],
  t: Ticket,
  facts?: SchedulerFacts
): string | null {
  if (isTicketDone(t)) return "it is done";
  // Stopped by the person: `paused` is the persisted version of the same thing,
  // so a card they stopped stays stopped across a server restart.
  if (t.paused) return "the person paused it";
  if (facts?.stopped(t.id)) return "the person stopped it";
  // Never two agents in one file: a ticket whose files another unfinished
  // ticket is touching waits.
  const index = createBoardIndex(tickets);
  const claim = index.fileHolders(t.id)[0];
  if (claim) return `waiting for ${claim.file}, held by “${claim.by.title}”`;
  const busy = index.workerBusyOn(t.id);
  if (busy) return `waiting for its worker, still on “${busy.title}”`;
  return t.status === "todo" ? null : `its status is ${t.status}`;
}

/**
 * The board's one promise, checked: a card the person sees in Working either
 * has an agent on it or is about to get one. Every card that breaks it, with
 * the reason the scheduler gave — an empty list is the invariant holding.
 */
export function stuckCards(
  tickets: Ticket[],
  facts?: SchedulerFacts
): { ticket: Ticket; why: string }[] {
  const out: { ticket: Ticket; why: string }[] = [];
  for (const t of tickets) {
    if (t.status !== "todo") continue;
    if (boardColumn(t) !== "working") continue;
    const why = notReadyReason(tickets, t, facts);
    if (why) out.push({ ticket: t, why });
  }
  return out;
}

export function ticketProgress(tickets: Ticket[]): { done: number; total: number } {
  return { done: tickets.filter(isTicketDone).length, total: tickets.length };
}
