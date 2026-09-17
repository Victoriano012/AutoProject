import {
  type AgentRequest,
  type Attachment,
  fileBlockedBy,
  isTicketDone,
  type Mode,
  notReadyReason,
  type Project,
  type SchedulerFacts,
  type Ticket,
  type Worker,
  workerBusyOn,
} from "../types";
import { resumableSession } from "../agent-session";
import { selectedModel } from "../config";
import { addStats } from "../stats";
import { type RunUsage, streamAgent } from "./agent";
import * as store from "./project-store";

/**
 * The run registry: agent runs execute here, in the server process, so they
 * outlive the browser tab that started them. Per-ticket entries are keyed by
 * `ticketKey(dir, id)`, per-project ones by the project dir. It does not
 * survive a server restart — a fresh process settles whatever project.json
 * still says is running (see settleZombies).
 */
interface Registry {
  /** Live agent sessions, by ticket key. */
  controllers: Map<string, AbortController>;
  /** Project runs that want to continue: draining now, or waiting on a review. */
  active: Set<string>;
  /** Scheduler loops actually draining work, by dir. */
  loops: Set<string>;
  /** Tickets the user stopped; the scheduler must not restart them. */
  userStopped: Set<string>;
  /** Human messages waiting for a ticket's files to come free, by ticket key. */
  pendingFeedback: Map<string, string>;
  /** Extra indications typed on a card whose agent is at work, by ticket key.
   * The ticket's own run loop takes them and resumes its session with them —
   * nothing else may, or there would be two agents in one workspace. */
  notes: Map<string, string[]>;
  /** Wakes a scheduler loop that is waiting on its runs, so it can pick up work
   * that appeared since (a card added while another card was running). */
  wakes: Map<string, () => void>;
  /** The project agent's live turn, by project dir — one agent per project. */
  agents: Map<string, AbortController>;
  /** Which mode that turn was sent in, so a client connecting mid-turn knows. */
  agentMode: Map<string, Mode>;
  /** Messages for the project agent, by dir, in the order they were sent: the
   * one running first, then the ones waiting, with failed ones left in place. */
  requests: Map<string, AgentRequest[]>;
  /** Hands a message to the project agent's live turn (see AgentEvent "input"),
   * by dir; absent while it runs on a CLI that cannot take one mid-turn. */
  inputs: Map<string, (text: string) => boolean>;
}

const globals = globalThis as unknown as { __autoprojectRegistry?: Registry };
export const registry: Registry = (globals.__autoprojectRegistry ??= {
  controllers: new Map(),
  active: new Set(),
  loops: new Set(),
  userStopped: new Set(),
  pendingFeedback: new Map(),
  notes: new Map(),
  wakes: new Map(),
  agents: new Map(),
  agentMode: new Map(),
  requests: new Map(),
  inputs: new Map(),
});
// A dev-server hot reload keeps the old registry object, which predates these.
registry.pendingFeedback ??= new Map();
registry.notes ??= new Map();
registry.wakes ??= new Map();
registry.agents ??= new Map();
registry.agentMode ??= new Map();
registry.requests ??= new Map();
registry.inputs ??= new Map();

const ticketKey = (dir: string, id: string) => dir + "\u0000" + id;

export interface RunState {
  /** Non-empty while the project's scheduler loop is draining work. */
  loops: string[];
  /** Non-empty while the project run wants to continue (including waiting on a review). */
  active: string[];
  /** Ids of tickets with a live agent session. */
  tickets: string[];
  /** The project agent: mid-turn or idle, in which mode it was asked, and the
   * requests it has running, waiting or failed. */
  agent: { busy: boolean; mode: Mode | null; requests: AgentRequest[] };
}

export function runState(dir: string): RunState {
  const prefix = dir + "\u0000";
  return {
    loops: registry.loops.has(dir) ? [dir] : [],
    active: registry.active.has(dir) ? [dir] : [],
    tickets: [...registry.controllers.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
    agent: {
      busy: registry.agents.has(dir),
      mode: registry.agentMode.get(dir) ?? null,
      requests: registry.requests.get(dir) ?? [],
    },
  };
}

export function notifyRuns(dir: string): void {
  store.publish(dir, { type: "runs" });
}

/** The project agent started or finished a turn, or its queue changed: tell
 * every open tab, both as its own event and through the run snapshot. */
export function notifyAgent(dir: string): void {
  store.publish(dir, { type: "agent", ...runState(dir).agent });
  notifyRuns(dir);
}

/** Load a project into the server store, settling orphans on a cold load. */
export function ensureLoaded(dir: string): Project | null {
  const cold = !store.isLoaded(dir);
  const project = store.getProject(dir);
  // A "running" left in project.json by a process that is gone has nothing to
  // abort and nothing that will ever finish it.
  if (project && cold) settleZombies(dir);
  return store.getProject(dir);
}

// ---- prompt building ------------------------------------------------------

function inheritedAttachments(project: Project, ticket: Ticket): Attachment[] {
  return [...(project.attachments ?? []), ...(ticket.attachments ?? [])];
}

const workerOf = (project: Project, ticket: Ticket): Worker | undefined =>
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

// ---- notes the person adds to a card in flight ----------------------------

/** Take the indications waiting for this ticket's agent. Always drains: the
 * board writes each one into the ticket itself as well, so the durable copy is
 * the ticket's description and this queue only carries the live hand-over. */
function takeNotes(key: string): string[] {
  const notes = registry.notes.get(key) ?? [];
  registry.notes.delete(key);
  return notes;
}

/** What an aborted session says in the log: the person's stop — unless it was
 * their own note interrupting the agent, which the run resumes from. */
function abortText(key: string): string {
  return registry.notes.has(key)
    ? "Taking your indication into account…"
    : "Stopped by user";
}

const ticketOf = (dir: string, id: string): Ticket | undefined =>
  store.getProject(dir)?.tickets.find((t) => t.id === id);

// ---- what the work cost ---------------------------------------------------

/**
 * Fold one agent session's numbers into the ticket that ran.
 *
 * A server-written ticket field, so `stats` is in `runFields` (see
 * run-state.ts) — without that the browser's next autosave would wipe every
 * total, since the browser owns the ticket otherwise.
 *
 * Only what the provider actually reported goes in: time is measured here,
 * tokens and cost come from the result message, and a run whose provider gave
 * no cost is counted in `runsWithoutCost` instead of being priced from a table.
 */
function recordRun(dir: string, ticketId: string, ms: number, usage?: RunUsage): void {
  store.updateTicket(dir, ticketId, (t) => ({
    ...t,
    stats: addStats(t.stats, {
      runs: 1,
      ms,
      tokens: usage?.tokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
      runsWithoutCost: usage?.costUsd === undefined ? 1 : 0,
    }),
  }));
}

// ---- one agent session ----------------------------------------------------

async function runAgentSession(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model?: string;
  }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketKey(dir, ticketId);
  const ctrl = new AbortController();
  registry.controllers.set(key, ctrl);
  notifyRuns(dir);

  let ok = false;
  let finalText = "";
  let usage: RunUsage | undefined;
  const started = Date.now();

  try {
    const events = streamAgent({
      workspaceDir: store.getProject(dir)?.workspaceDir,
      prompt: body.prompt,
      sessionId: body.sessionId,
      attachments: body.attachments?.map(({ name, dataUrl }) => ({ name, dataUrl })),
      signal: ctrl.signal,
      model: body.model,
      writeAccess: true,
    });
    for await (const ev of events) {
      if (ev.type === "init") {
        store.updateTicket(dir, ticketId, (t) => ({ ...t, sessionId: ev.sessionId }));
        // The worker's conversation is what its next ticket resumes.
        const workerId = ticketOf(dir, ticketId)?.workerId;
        if (workerId) store.setWorkerSession(dir, workerId, ev.sessionId);
      } else if (ev.type === "text") {
        store.appendLog(dir, ticketId, { kind: "text", text: ev.text, ts: Date.now() });
      } else if (ev.type === "tool") {
        store.appendLog(dir, ticketId, { kind: "tool", text: ev.text, ts: Date.now() });
      } else if (ev.type === "result") {
        ok = ev.ok;
        finalText = ev.text ?? "";
        usage = ev.usage;
      } else if (ev.type === "error") {
        ok = false;
        finalText = ev.message;
        // An error the abort itself caused is not the run's own failure — the
        // CLI reports the interrupt as one. What actually happened (the person's
        // stop, or their note) is logged below instead.
        if (!ctrl.signal.aborted) {
          store.appendLog(dir, ticketId, { kind: "error", text: ev.message, ts: Date.now() });
        }
      }
    }
    if (ctrl.signal.aborted) {
      ok = false;
      finalText = "Stopped by user";
      store.appendLog(dir, ticketId, { kind: "info", text: abortText(key), ts: Date.now() });
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    store.appendLog(dir, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: ctrl.signal.aborted ? abortText(key) : finalText,
      ts: Date.now(),
    });
  } finally {
    registry.controllers.delete(key);
    // A stopped or failed session still spent the time and the tokens it spent.
    recordRun(dir, ticketId, Date.now() - started, usage);
    notifyRuns(dir);
  }
  return { ok, text: finalText, aborted: ctrl.signal.aborted };
}

/**
 * The ticket's session, and any session the person's own indications ask for
 * after it. A note typed on the card interrupts the open session (see
 * `noteTicket`); this resumes that same session with what they said, so
 * everything the agent had already done stays in its context, the ticket keeps
 * its "running" status throughout — the card never leaves Working — and there
 * is never a second agent in one workspace. Normally exactly one pass.
 */
async function runWithNotes(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model: string;
  }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketKey(dir, ticketId);
  for (;;) {
    const outcome = await runAgentSession(dir, ticketId, body);
    const notes = takeNotes(key);
    if (notes.length === 0 || registry.userStopped.has(key)) return outcome;
    const resumed = resumableSession(ticketOf(dir, ticketId)?.sessionId, body.model)?.stored;
    // No session to resume (the agent never reached init): the ticket settles,
    // and the indication is still in its description for the next run.
    if (!resumed) return outcome;
    body = {
      prompt:
        `While you were working, the person added indications for this ticket:\n\n` +
        notes.join("\n\n") +
        `\n\nTake them into account and carry on with the ticket, then finish as instructed above.`,
      sessionId: resumed,
      model: body.model,
    };
  }
}

/**
 * The person's stop, written where everyone can see it.
 *
 * `userStopped` lives in the registry, so it is invisible to the board: a card
 * held out of the queue by it alone sits in the Working column labelled Queued
 * with nothing ever starting it, which is exactly the lie this whole invariant
 * exists to prevent. `paused` is the persisted half of the same fact — the
 * board reads it (`boardColumn` → Blocked, "Paused", with a Run button back)
 * and it survives a server restart, which the skip never did.
 *
 * Only ever written once the ticket is out of "running": the board clears a
 * pause it sees on a card whose agent is still winding down, so a run being
 * aborted parks itself in the same write that settles its status (see
 * `runTicketOnce`).
 *
 * And only on "todo", the one status that can lie: that is the card the board
 * shows in Working as Queued. A card in review or error already says what it
 * is, and parking it would move it out of the column the person left it in.
 */
function park(dir: string, ticketId: string): void {
  const t = ticketOf(dir, ticketId);
  if (!t || t.paused || t.status !== "todo") return;
  store.updateTicket(dir, ticketId, (x) => ({ ...x, paused: true }));
}

/** The other half of lifting the skip: pressing run un-parks the ticket, or it
 * would be blocked by the stop it was just started out of. */
function unpark(dir: string, ticketId: string): void {
  if (ticketOf(dir, ticketId)?.paused) {
    store.updateTicket(dir, ticketId, (x) => ({ ...x, paused: false }));
  }
}

/** One agent session on a ticket, from todo to review (or error). */
async function runTicketOnce(dir: string, ticketId: string): Promise<void> {
  const project = store.getProject(dir);
  const ticket = project?.tickets.find((t) => t.id === ticketId);
  if (!project || !ticket || ticket.status === "running") return;

  store.updateTicket(dir, ticketId, (t) => ({ ...t, status: "running" }));
  store.appendLog(dir, ticketId, { kind: "info", text: "Run started", ts: Date.now() });
  const prompt = ticketPrompt(project, ticket);
  store.appendLog(dir, ticketId, { kind: "user", text: prompt, ts: Date.now() });

  const model = selectedModel();
  const { ok, text, aborted } = await runWithNotes(dir, ticketId, {
    prompt,
    // The worker's conversation, so it keeps what its earlier tickets taught it.
    sessionId: resumableSession(workerOf(project, ticket)?.sessionId, model)?.stored,
    attachments: inheritedAttachments(project, ticket),
    model,
  });

  const summary = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
  // The person's stop and the settled status land in one write: a card that
  // went back to todo because they stopped it must never be seen as Queued.
  const stopped = registry.userStopped.has(ticketKey(dir, ticketId));
  // Skip the final write if something else already moved the ticket out of
  // "running" (e.g. a rejection reset it to todo while aborting).
  // A user stop is not a failure: the ticket goes back to todo, and "error"
  // stays reserved for runs where the agent actually failed.
  store.updateTicket(dir, ticketId, (t) =>
    t.status !== "running"
      ? t
      : aborted
        ? { ...t, status: "todo", ...(stopped ? { paused: true } : {}) }
        : { ...t, status: !ok ? "error" : "review", resultSummary: summary }
  );
}

/**
 * An extra indication the person typed on an in-progress card (the board's note
 * button), for that ticket's own agent and nothing else.
 *
 * It never starts one. A card the scheduler has not started is standing still
 * for a reason — another card in its files, the person's own pause — and
 * starting an agent from here would break exactly the rule that kept it out of
 * the queue, so the only card whose agent hears this now is one whose session
 * is genuinely open: it is interrupted, and its run loop (`runTicketOnce`)
 * resumes the same session with the indication. Every other card already
 * carries the indication in its description, written by the board before this
 * call, so its run reads it whenever it does start — which is why nothing here
 * has to be kept for it, and why a server restart cannot lose it. The board
 * shows the indication itself; no line about when it will be read is added.
 */
export function noteTicket(dir: string, ticketId: string, message: string): void {
  const text = message.trim();
  const project = store.getProject(dir);
  const ticket = project?.tickets.find((t) => t.id === ticketId);
  if (!project || !ticket || !text) return;

  store.appendLog(dir, ticketId, { kind: "user", text, ts: Date.now() });

  if (ticket.status !== "running") return;
  const key = ticketKey(dir, ticketId);
  registry.notes.set(key, [...(registry.notes.get(key) ?? []), text]);
  // The interrupt is what makes it live; the run loop does the rest. A ticket
  // marked running with no session left to interrupt (a restart settles those)
  // still has the indication in its description.
  registry.controllers.get(key)?.abort();
}

/** The session a ticket's feedback resumes: its worker's — one conversation
 * for all of that worker's tickets — or, for a ticket from before workers, its
 * own. */
const sessionFor = (project: Project, ticket: Ticket): string | undefined =>
  workerOf(project, ticket)?.sessionId ?? ticket.sessionId;

/** Why this ticket's agent cannot start right now, worded for its log: another
 * card is in one of its files, or its worker is still on another card. */
function holdReason(tickets: Ticket[], ticketId: string): string | null {
  const claim = fileBlockedBy(tickets, ticketId);
  if (claim) return `Waiting for ${claim.file}: “${claim.by.title}” is changing it.`;
  const busy = workerBusyOn(tickets, ticketId);
  if (busy) return `Waiting for its worker: still on “${busy.title}”.`;
  return null;
}

/** Send human feedback into the ticket's existing agent session. */
export async function sendFeedback(
  dir: string,
  ticketId: string,
  message: string,
  rejection = false,
  // The message is already on the card's log, written when it was queued.
  logged = false
): Promise<void> {
  const project = store.getProject(dir);
  const ticket = project?.tickets.find((t) => t.id === ticketId);
  if (!project || !ticket) return;

  // The one thing the logs cannot be read back for: a rejection and a note both
  // write the same `kind: "user"` line, so the count is kept as it happens.
  // `rejection` is the board's ✕ — which may reset the card to todo before this
  // call, so its status cannot be trusted here.
  if (rejection || ticket.status === "review") {
    store.updateTicket(dir, ticketId, (t) => ({
      ...t,
      stats: addStats(t.stats, { rejections: 1 }),
    }));
  }

  // Answering a ticket puts its agent back to work, which re-claims its files
  // and its worker — and another ticket may have taken either while it sat in
  // review. The message waits with the ticket rather than starting a second
  // agent in that file or conversation; the scheduler delivers it (see
  // runTicket) as soon as they free.
  const held = holdReason(project.tickets, ticketId);
  if (held) {
    const key = ticketKey(dir, ticketId);
    const queued = registry.pendingFeedback.get(key);
    registry.pendingFeedback.set(key, queued ? `${queued}\n\n${message}` : message);
    // The wait, then what waits: the card shows the person their own words
    // under the reason nothing has happened to them yet. The wait line goes
    // when the agent gets them (see runTicket).
    store.appendLog(dir, ticketId, { kind: "info", text: held, ts: Date.now() });
    store.appendLog(dir, ticketId, { kind: "user", text: message, ts: Date.now() });
    store.updateTicket(dir, ticketId, (t) => ({ ...t, status: "todo" }));
    return;
  }

  const model = selectedModel();
  const activeSession = resumableSession(sessionFor(project, ticket), model)?.stored;
  // A ticket with no session of its own never ran, so this is the human opening
  // the work rather than reacting to it: the agent reads the ticket first —
  // even a worker that has done other tickets has not seen this one.
  const opening = resumableSession(ticket.sessionId, model)
    ? undefined
    : ticketPrompt(project, ticket);
  if (opening) {
    store.appendLog(dir, ticketId, { kind: "user", text: opening, ts: Date.now() });
  }
  if (!logged) {
    store.appendLog(dir, ticketId, { kind: "user", text: message, ts: Date.now() });
  }
  store.updateTicket(dir, ticketId, (t) => ({ ...t, status: "running" }));

  const { ok, text, aborted } = await runWithNotes(dir, ticketId, {
    prompt: opening
      ? `${opening}\n\nThe human is starting this ticket with a request:\n\n${message}`
      : `Human review feedback on your work for this ticket:\n\n${message}\n\nAddress the feedback, then end with a short summary of what you changed.`,
    sessionId: activeSession,
    model,
  });

  // Stopped feedback is not a failure: the earlier work still awaits review.
  store.updateTicket(dir, ticketId, (t) =>
    t.status !== "running"
      ? t
      : aborted
        ? { ...t, status: "review" }
        : {
            ...t,
            status: ok ? "review" : "error",
            resultSummary: text.length > 1500 ? text.slice(0, 1500) + "…" : text,
          }
  );
  // An answered ticket can unblock the rest of the board (its files come free)
  // and nothing else here would notice.
  autoRun(dir);
}

/** Reject a ticket in review with feedback (the board's red cross): the
 * feedback resumes the ticket's agent session. */
export function rejectTicket(dir: string, ticketId: string, message: string): Promise<void> {
  return sendFeedback(dir, ticketId, message, true);
}

/** Approve a ticket in review (or force-complete any ticket). */
export function approveTicket(dir: string, ticketId: string): void {
  store.updateTicket(dir, ticketId, (t) => ({ ...t, status: "done" }));
  // Approving releases the ticket's files, which may be all another card needed.
  autoRun(dir);
}

/** Run one ticket's agent. */
export async function runTicket(dir: string, ticketId: string): Promise<void> {
  const key = ticketKey(dir, ticketId);
  registry.userStopped.delete(key);
  unpark(dir, ticketId);
  const project = store.getProject(dir);
  if (!project?.tickets.some((t) => t.id === ticketId)) return;

  // The scheduler filters these out, so this catches the person pressing Run on
  // a card whose file someone else is already in, or whose worker is busy —
  // and the scheduler starting two such cards from one ready set: the first to
  // start is running by the time the second gets here. Saying so beats doing
  // nothing.
  const held = holdReason(project.tickets, ticketId);
  if (held) {
    store.appendLog(dir, ticketId, { kind: "info", text: held, ts: Date.now() });
    return;
  }

  // Starting: the card is not waiting any more, so the lines saying it was
  // (this function's and sendFeedback's) come off its log.
  store.updateTicket(dir, ticketId, (t) => ({
    ...t,
    log: t.log.filter((e) => !(e.kind === "info" && e.text.startsWith("Waiting for "))),
  }));

  // A message that arrived while the ticket's file or worker was taken: now
  // that it is free, the ticket goes back to its own agent with what the person said.
  const waiting = registry.pendingFeedback.get(key);
  if (waiting) {
    registry.pendingFeedback.delete(key);
    await sendFeedback(dir, ticketId, waiting, false, true);
    return;
  }

  await runTicketOnce(dir, ticketId);

  // What just finished may have unblocked another card. Inside a scheduler loop
  // this only nudges a loop that was going to look anyway; outside one — the run
  // button, an unpause — it is the only thing that would.
  autoRun(dir);
}

/** The tickets an agent could be started on right now. The scheduler
 * dispatches exactly these, and `autoRun` asks the same question to decide
 * whether starting a scheduler is worth it — one definition, so the two can
 * never disagree and spin. The rules live in `notReadyReason`, which the board
 * also uses to check that a card it shows in Working really is about to run;
 * only the one fact that exists solely in this process is supplied from here. */
function readyTickets(dir: string): Ticket[] {
  const tickets = store.getProject(dir)?.tickets ?? [];
  const facts = schedulerFacts(dir);
  return tickets.filter((t) => notReadyReason(tickets, t, facts) === null);
}

/** The fact `notReadyReason` cannot know: which tickets the person stopped. */
function schedulerFacts(dir: string): SchedulerFacts {
  return { stopped: (id: string) => registry.userStopped.has(ticketKey(dir, id)) };
}

/**
 * The board runs itself: the moment a card can start it gets its agent, rather
 * than sitting queued until somebody presses run. Cheap and safe to call after
 * anything that could have unblocked a card — a new card from the project
 * agent, an approval, a finished run releasing a file — because it starts a
 * scheduler only when there is a card it could actually dispatch, and
 * `runProject` is a no-op while a loop is already draining the board.
 */
export function autoRun(dir: string): void {
  // A loop is already draining this board, but it is asleep until one of its
  // runs finishes — which is why a card added next to a running one used to sit
  // queued for as long as that card took. Wake it so it looks again now.
  if (registry.loops.has(dir)) {
    registry.wakes.get(dir)?.();
    return;
  }
  if (readyTickets(dir).length === 0) return;
  // resume: never lift the person's stop just because the board moved on.
  void runProject(dir, true);
}

/**
 * Pressing run is the person saying "go" about everything on the board, so a
 * ticket sitting at "error" goes back to "todo" — the same thing its own Retry
 * button does — and the scheduler can pick it up again. The failure's log
 * entries stay: what went wrong is history, not state.
 *
 * Only from an explicit run (`resume === false`). The board's automatic
 * scheduler resumes, so "error" stays terminal for it — otherwise a card that
 * fails every time would be retried for as long as the board is open.
 *
 * A ticket the person paused or stopped is left where it is — which is why the
 * caller asks this before it lifts the stops: run un-pauses a ticket that was
 * waiting its turn, as it always has, but a failure the person stopped is not
 * work they asked to see attempted again.
 */
function reviveFailures(dir: string): void {
  for (const t of store.getProject(dir)?.tickets ?? []) {
    if (t.status !== "error" || t.paused) continue;
    if (registry.userStopped.has(ticketKey(dir, t.id))) continue;
    store.updateTicket(dir, t.id, (x) => (x.status === "error" ? { ...x, status: "todo" } : x));
  }
}

/**
 * Run every ticket on the board, files permitting. All ready tickets run in
 * parallel, each in its own agent session; whenever one finishes, newly
 * unblocked tickets are started.
 */
export async function runProject(dir: string, resume = false): Promise<void> {
  // Pressing run lifts the user-stopped skip; only an internal resume (an
  // approval, a rejection, a new card) keeps it, so the board moving on never
  // restarts work the user deliberately stopped. This cannot be inferred from
  // `active`: a run waiting on a review stays active until the review is
  // answered, which would freeze the skip for good.
  if (!resume) {
    // Failures first, while the stops still say what the person said: pressing
    // run gives every failure another go, but not one they had deliberately
    // stopped — even though the next lines lift that stop.
    reviveFailures(dir);
    const prefix = dir + "\u0000";
    for (const key of [...registry.userStopped])
      if (key.startsWith(prefix)) registry.userStopped.delete(key);
    for (const t of store.getProject(dir)?.tickets ?? []) unpark(dir, t.id);
  }
  registry.active.add(dir);
  if (registry.loops.has(dir)) return; // a scheduler loop is already draining this board
  registry.loops.add(dir);
  notifyRuns(dir);

  const inFlight = new Map<string, Promise<void>>(); // ticket ids currently running

  try {
    for (;;) {
      // Start everything currently ready (unless the user stopped the run).
      if (registry.active.has(dir)) {
        if (!store.getProject(dir)) break;
        const ready = readyTickets(dir).filter((t) => !inFlight.has(t.id));
        for (const t of ready) {
          inFlight.set(
            t.id,
            runTicket(dir, t.id)
              .catch((err) =>
                store.appendLog(dir, t.id, { kind: "error", text: String(err), ts: Date.now() })
              )
              .finally(() => inFlight.delete(t.id))
          );
        }
      }
      if (inFlight.size === 0) break;
      // Wake when any ticket finishes — or when `autoRun` says new work landed
      // on the board — then recompute the ready set.
      const woken = new Promise<void>((resolve) => registry.wakes.set(dir, resolve));
      await Promise.race([...inFlight.values(), woken]);
      registry.wakes.delete(dir);
    }
  } finally {
    // The loop only ever waits on work in flight, so leaving it means the
    // board has settled: nothing is executing any more.
    registry.loops.delete(dir);
    registry.wakes.delete(dir);
    // Keep the resume flag only while a person still owes an answer — a ticket
    // in review — so their approval or rejection resumes the run.
    const tickets = store.getProject(dir)?.tickets ?? [];
    if (!tickets.some((t) => t.status === "review")) registry.active.delete(dir);
    notifyRuns(dir);
  }
}

/** Does a live run own this ticket's run state? (A person's own status edit
 * must not overwrite a run in progress.) */
export function ownsTicket(dir: string, id: string): boolean {
  return registry.controllers.has(ticketKey(dir, id));
}

/** A zombie "running" — a persisted status whose run died with the server
 * process — has nothing to abort and nothing that will ever write a final
 * status, so settle it back to todo. Live runs settle themselves after the
 * abort (and must not be reset here: a todo ticket would make the scheduler
 * consider it runnable again and restart it). */
function settleZombie(dir: string, ticketId: string): void {
  const t = ticketOf(dir, ticketId);
  if (t && t.status === "running" && !ownsTicket(dir, ticketId))
    store.updateTicket(dir, ticketId, (x) => ({ ...x, status: "todo" }));
}

/** Settle every ticket left marked running that no live run backs: after a
 * server restart that is every one of them, and while the server is up it is
 * exactly the ones whose run is gone. The registry answers, so this never
 * settles a ticket that is genuinely running. */
export function settleZombies(dir: string): void {
  for (const t of store.getProject(dir)?.tickets ?? []) settleZombie(dir, t.id);
}

/** Abort a ticket's run without marking it user-stopped, so the ticket is free
 * to run again right away. */
function abortRun(dir: string, ticketId: string): void {
  registry.controllers.get(ticketKey(dir, ticketId))?.abort();
  settleZombie(dir, ticketId);
}

export function stopTicket(dir: string, ticketId: string): void {
  registry.userStopped.add(ticketKey(dir, ticketId));
  abortRun(dir, ticketId);
  // A ticket with no live agent parks now; one still winding down parks in the
  // write that settles it (see runTicketOnce).
  park(dir, ticketId);
  notifyRuns(dir);
}

/** `byUser` is the person pressing Stop: its tickets are marked user-stopped so
 * nothing (the board's own auto-run included) starts them again until the
 * person presses run. An internal stop leaves them free to run. */
export function stopProject(dir: string, byUser = false): void {
  registry.active.delete(dir);
  for (const t of store.getProject(dir)?.tickets ?? []) {
    if (byUser && !isTicketDone(t)) registry.userStopped.add(ticketKey(dir, t.id));
    registry.controllers.get(ticketKey(dir, t.id))?.abort();
    settleZombie(dir, t.id);
    // Same as stopTicket: the stop has to be visible, or every card this just
    // took out of the queue keeps saying Queued for good.
    if (byUser) park(dir, t.id);
  }
  notifyRuns(dir);
}

/** True while the project's run is actually executing: its scheduler loop is
 * draining work. A run waiting on a review is *not* running — `active`
 * remembers that it wants to continue. */
export function isProjectRunning(dir: string): boolean {
  return registry.loops.has(dir);
}

/** Delete tickets. The server owns the ticket set, so this is where a deletion
 * happens; a run still on one of them is stopped first, and its final write
 * then finds no ticket to settle. */
export function removeTickets(dir: string, ids: string[]): void {
  for (const id of ids) {
    const key = ticketKey(dir, id);
    registry.controllers.get(key)?.abort();
    registry.userStopped.delete(key);
    registry.pendingFeedback.delete(key);
    registry.notes.delete(key);
  }
  store.removeTickets(dir, ids);
  notifyRuns(dir);
}
