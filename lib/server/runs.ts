import {
  type AgentRequest,
  isTicketDone,
  type LiveSubagent,
  type Mode,
  type Project,
  type Ticket,
} from "../types";
import { resumableSession } from "../agent-session";
import { selectedModel } from "../config";
import { addStats } from "../stats";
import * as store from "./project-store";

import { registry, ticketKey } from "./run-registry";
export { registry } from "./run-registry";
import { createBoardIndex } from "../board-index";
import { inheritedAttachments, workerOf, ticketPrompt } from "./ticket-prompt";
import { runWithNotes } from "./ticket-session";
export { ticketPrompt } from "./ticket-prompt";

export interface RunState {
  /** Non-empty while the project's scheduler loop is draining work. */
  loops: string[];
  /** Non-empty while the project run wants to continue (including waiting on a review). */
  active: string[];
  /** Ids of tickets with a live agent session. */
  tickets: string[];
  /** The project agent: mid-turn or idle, in which mode it was asked, the
   * requests it has running, waiting or failed, and the subagents at work. */
  agent: {
    busy: boolean;
    mode: Mode | null;
    requests: AgentRequest[];
    subagents: LiveSubagent[];
  };
}

export function runState(dir: string): RunState {
  const prefix = dir + "\u0000";
  return {
    loops: registry.loops.has(dir) ? [dir] : [],
    active: registry.active.has(dir) ? [dir] : [],
    tickets: [...new Set([...registry.claims.keys(), ...registry.controllers.keys()])]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
    agent: {
      busy: registry.agents.has(dir),
      mode: registry.agentMode.get(dir) ?? null,
      requests: registry.requests.get(dir) ?? [],
      subagents: registry.subagents.get(dir) ?? [],
    },
  };
}

export function notifyRuns(dir: string): void {
  store.publish(dir, { type: "runs" });
}

/** The project agent started or finished a turn, or its queue changed: tell
 * every open tab, both as its own event and through the run snapshot. */
export function notifyAgent(dir: string): void {
  const project = store.getProject(dir);
  if (project) store.setProject(dir, { ...project, agentRequests: (registry.requests.get(dir) ?? []).map((r) => ({ ...r })) });
  store.publish(dir, { type: "agent", ...runState(dir).agent });
  notifyRuns(dir);
}

/** Load a project into the server store, settling orphans on a cold load. */
export function ensureLoaded(dir: string): Project | null {
  if (registry.removing.has(dir)) return null;
  const cold = !store.isLoaded(dir);
  const project = store.getProject(dir);
  // A "running" left in project.json by a process that is gone has nothing to
  // abort and nothing that will ever finish it.
  if (project && (cold || !registry.requests.has(dir))) {
    if (cold) settleZombies(dir);
    for (const [id, message] of Object.entries(project.pendingFeedback ?? {})) {
      registry.pendingFeedback.set(ticketKey(dir, id), message);
    }
    // Interrupted requests are retained for an explicit retry; never silently
    // replay an action after a crash. Requests not yet dispatched stay queued.
    registry.requests.set(dir, (project.agentRequests ?? []).map((request) =>
      request.state === "running"
        ? { ...request, state: "error" as const, error: "Server restarted during this request. Retry to continue." }
        : { ...request },
    ));
    if (Object.keys(project.pendingFeedback ?? {}).length) queueMicrotask(() => autoRun(dir));
    if ((registry.requests.get(dir) ?? []).some((request) => request.state === "queued")) {
      void import("./project-agent").then(({ resumeQueuedAgent }) => {
        if (!registry.removing.has(dir)) resumeQueuedAgent(dir);
      }).catch((error) => console.error("Could not restore the project queue", error));
    }
  }
  return store.getProject(dir);
}

const ticketOf = (dir: string, id: string): Ticket | undefined =>
  store.getProject(dir)?.tickets.find((t) => t.id === id);

/** Persist the stop immediately, even while an abort is winding down, so a
 * crash before process exit cannot turn stopped work into runnable work. */
function park(dir: string, ticketId: string): void {
  const t = ticketOf(dir, ticketId);
  if (!t || t.paused || (t.status !== "todo" && t.status !== "running")) return;
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

/** Runtime claims outlive card edits/deletion and are released only after the
 * complete run has unwound, including any resumed notes. */
export function claimedTickets(dir: string): Ticket[] {
  const tickets = new Map((store.getProject(dir)?.tickets ?? []).map((t) => [t.id, t]));
  for (const claim of registry.claims.values()) {
    if (claim.dir === dir) tickets.set(claim.ticket.id, { ...claim.ticket, status: "running" });
  }
  return [...tickets.values()];
}

function holdReason(dir: string, ticketId: string): string | null {
  if (ownsTicket(dir, ticketId)) return "Waiting for the previous run to finish stopping.";
  const index = createBoardIndex(claimedTickets(dir));
  const claim = index.fileHolders(ticketId)[0];
  if (claim) return `Waiting for ${claim.file}: “${claim.by.title}” is changing it.`;
  const busy = index.workerBusyOn(ticketId);
  if (busy) return `Waiting for its worker: still on “${busy.title}”.`;
  return null;
}

async function withTicketClaim(dir: string, ticketId: string, work: () => Promise<void>): Promise<void> {
  if (registry.removing.has(dir) || ownsTicket(dir, ticketId)) return;
  const ticket = ticketOf(dir, ticketId);
  if (!ticket) return;
  const key = ticketKey(dir, ticketId);
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  registry.claims.set(key, { dir, ticket: { ...ticket, files: [...(ticket.files ?? [])] }, done, release });
  try { await work(); }
  finally {
    registry.claims.delete(key);
    if (registry.pendingFeedback.has(key) && !registry.userStopped.has(key) && !registry.removing.has(dir)) {
      store.updateTicket(dir, ticketId, (ticket) => ({ ...ticket, status: "todo" }));
    }
    release();
    notifyRuns(dir);
    autoRun(dir);
  }
}

function persistFeedback(dir: string): void {
  const project = store.getProject(dir);
  if (!project) return;
  const prefix = dir + "\u0000";
  const pendingFeedback = Object.fromEntries([...registry.pendingFeedback]
    .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  store.setProject(dir, { ...project, pendingFeedback });
}

export async function sendFeedback(
  dir: string, ticketId: string, message: string, rejection = false, logged = false,
): Promise<void> {
  const ticket = ticketOf(dir, ticketId);
  if (registry.removing.has(dir) || !ticket) return;
  if (!logged && (rejection || ticket.status === "review")) {
    store.updateTicket(dir, ticketId, (t) => ({ ...t, stats: addStats(t.stats, { rejections: 1 }) }));
  }
  const held = holdReason(dir, ticketId);
  if (held) {
    const key = ticketKey(dir, ticketId);
    const queued = registry.pendingFeedback.get(key);
    registry.pendingFeedback.set(key, queued ? `${queued}\n\n${message}` : message);
    persistFeedback(dir);
    // The wait, then what waits: the card shows the person their own words
    // under the reason nothing has happened to them yet. The wait line goes
    // when the agent gets them (see runTicket).
    store.appendLog(dir, ticketId, { kind: "info", text: held, ts: Date.now() });
    store.appendLog(dir, ticketId, { kind: "user", text: message, ts: Date.now() });
    if (!ownsTicket(dir, ticketId)) store.updateTicket(dir, ticketId, (t) => ({ ...t, status: "todo" }));
    return;
  }

  await withTicketClaim(dir, ticketId, () => sendFeedbackNow(dir, ticketId, message, logged));
}

/** Send human feedback into the ticket's existing agent session. */
async function sendFeedbackNow(
  dir: string,
  ticketId: string,
  message: string,
  // The message is already on the card's log, written when it was queued.
  logged = false
): Promise<void> {
  const project = store.getProject(dir);
  const ticket = project?.tickets.find((t) => t.id === ticketId);
  if (!project || !ticket) return;

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
  // An idle approved ticket may unblock work. A live process retains its claims.
  autoRun(dir);
}

/** Run one ticket's agent. */
export async function runTicket(dir: string, ticketId: string): Promise<void> {
  if (registry.removing.has(dir) || ownsTicket(dir, ticketId)) return;
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
  const held = holdReason(dir, ticketId);
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
    persistFeedback(dir);
    await withTicketClaim(dir, ticketId, () => sendFeedbackNow(dir, ticketId, waiting, true));
    return;
  }

  await withTicketClaim(dir, ticketId, () => runTicketOnce(dir, ticketId));

  // What just finished may have unblocked another card. Inside a scheduler loop
  // this only nudges a loop that was going to look anyway; outside one — the run
  // button, an unpause — it is the only thing that would.
  autoRun(dir);
}

/** Index one scheduler snapshot, including claims for cards removed or edited
 * while their processes are still winding down. */
function readyTickets(dir: string): Ticket[] {
  if (registry.removing.has(dir)) return [];
  const tickets = store.getProject(dir)?.tickets ?? [];
  const index = createBoardIndex(claimedTickets(dir));
  return tickets.filter((t) => t.status === "todo" && !t.paused &&
    !registry.userStopped.has(ticketKey(dir, t.id)) && !ownsTicket(dir, t.id) &&
    index.fileHolders(t.id).length === 0 && !index.workerBusyOn(t.id));
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
  if (registry.removing.has(dir)) return;
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
export function runProject(dir: string, resume = false): Promise<void> {
  const existing = registry.loopTasks.get(dir);
  if (existing) {
    if (!resume) void drainProject(dir, false);
    return existing;
  }
  const task = drainProject(dir, resume);
  registry.loopTasks.set(dir, task);
  void task.finally(() => registry.loopTasks.delete(dir)).catch((error) => console.error("Scheduler failed", error));
  return task;
}

async function drainProject(dir: string, resume: boolean): Promise<void> {
  if (registry.removing.has(dir)) return;
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
  return registry.claims.has(ticketKey(dir, id)) || registry.controllers.has(ticketKey(dir, id));
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
  const key = ticketKey(dir, ticketId);
  registry.userStopped.add(key);
  registry.pendingFeedback.delete(key);
  registry.notes.delete(key);
  persistFeedback(dir);
  abortRun(dir, ticketId);
  // Persist immediately; the process keeps its runtime claim until it exits.
  park(dir, ticketId);
  notifyRuns(dir);
}

/** `byUser` is the person pressing Stop: its tickets are marked user-stopped so
 * nothing (the board's own auto-run included) starts them again until the
 * person presses run. An internal stop leaves them free to run. */
export function stopProject(dir: string, byUser = false): void {
  registry.active.delete(dir);
  registry.agents.get(dir)?.abort();
  registry.requests.set(dir, []);
  const prefix = dir + "\u0000";
  for (const [key, controller] of registry.controllers) if (key.startsWith(prefix)) controller.abort();
  for (const key of registry.pendingFeedback.keys()) if (key.startsWith(prefix)) registry.pendingFeedback.delete(key);
  for (const key of registry.notes.keys()) if (key.startsWith(prefix)) registry.notes.delete(key);
  persistFeedback(dir);
  const project = store.getProject(dir);
  if (project) store.setProject(dir, { ...project, agentRequests: [] });
  notifyAgent(dir);
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
    registry.userStopped.add(key);
    registry.pendingFeedback.delete(key);
    registry.notes.delete(key);
  }
  persistFeedback(dir);
  store.removeTickets(dir, ids);
  notifyRuns(dir);
}
