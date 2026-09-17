"use client";

import { useStore } from "./store";
import type { AgentRequest, LiveSubagent, Mode } from "./types";

/**
 * Runs execute in the server process, not in this tab: this module is the thin
 * client for /api/runs and /api/agent. Starting a run is a request the server
 * owns from then on, so reloading or closing the page leaves it running, and
 * the run's status, logs and session ids are written by the server (they
 * arrive back through the live subscription in sync.ts).
 */

/** What the server says is actually live for the open project. */
export interface RunStateSnapshot {
  /** Non-empty while the project's scheduler loop is draining work. */
  loops: string[];
  /** Non-empty while the project run wants to continue. */
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

let state: RunStateSnapshot = {
  loops: [],
  active: [],
  tickets: [],
  agent: { busy: false, mode: null, requests: [], subagents: [] },
};
// Watchers of the run state (the toolbar, the bottom bar). Pushed, not polled.
const runListeners = new Set<() => void>();

/** Subscribe to run-state changes; returns the unsubscribe. */
export function subscribeRuns(fn: () => void): () => void {
  runListeners.add(fn);
  return () => {
    runListeners.delete(fn);
  };
}

export function notifyRuns(): void {
  for (const fn of [...runListeners]) fn();
}

/** Adopt the server's run state (the live subscription and every response). */
export function applyRunState(next: RunStateSnapshot): void {
  state = next;
  notifyRuns();
}

/** True while the project's run is actually executing in the server: its
 * scheduler loop is draining work. */
export function isProjectRunning(): boolean {
  return state.loops.length > 0;
}

/** True while a live agent session is open on exactly this ticket. */
export function isTicketRunLive(ticketId: string): boolean {
  return state.tickets.includes(ticketId);
}

/** True while the project agent is mid-turn. */
export function agentBusy(): boolean {
  return state.agent.busy;
}

/** The project agent's stack: the request running, the ones waiting behind
 * it and any that failed, in the order they were sent. */
export function agentRequests(): AgentRequest[] {
  return state.agent.requests;
}

/** The subagents the project agent's turn has working for it right now. */
export function agentSubagents(): LiveSubagent[] {
  return state.agent.subagents;
}

let flushProject: () => Promise<void> = async () => {};
let pokeStream: () => void = () => {};

/** sync.ts registers its feed check here: a person's action is the moment they
 * are watching for a result, so it is the moment to notice a dead feed. */
export function setStreamPoke(fn: () => void): void {
  pokeStream = fn;
}

/** sync.ts registers its autosave flush here: the server runs from its own copy
 * of the project, so pending edits go first. */
export function setProjectFlush(fn: () => Promise<void>): void {
  flushProject = fn;
}

/** Fires an action at the server; false means it never got there. Only worth
 * asking for when somebody is watching for the result of this one action —
 * everything else goes through `call`, since a run's own progress comes back
 * through the live subscription regardless. `dir` defaults to the open project;
 * the project picker names one. */
async function post(
  action: string,
  body: { ticketId?: string; ticketIds?: string[]; message?: string } = {},
  dir: string | null = useStore.getState().projectId
): Promise<boolean> {
  if (!dir) return false;
  pokeStream();
  await flushProject();
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, action, ...body }),
    });
    const data = (await res.json().catch(() => null)) as {
      runs?: RunStateSnapshot;
    } | null;
    if (data?.runs) applyRunState(data.runs);
    return res.ok;
  } catch {
    // The tab can go away mid-run; the run continues server-side and the live
    // subscription carries whatever happened next.
    return false;
  }
}

async function call(
  action: string,
  body: { ticketId?: string; ticketIds?: string[]; message?: string } = {},
  dir?: string
): Promise<void> {
  await post(action, body, dir);
}

/** Run one ticket's agent. Resolves when the run settles server-side. */
export function runTicket(ticketId: string): Promise<void> {
  return call("runTicket", { ticketId });
}

export function stopTicket(ticketId: string): void {
  void call("stopTicket", { ticketId });
}

/** Run every ticket on the board, files permitting. Resolves when that
 * scheduler loop settles server-side. */
export function runProject(dir?: string): Promise<void> {
  return call("runProject", {}, dir);
}

export function stopProject(dir?: string): void {
  void call("stopProject", {}, dir);
}

/** Send human feedback into the ticket's existing agent session. */
export function sendFeedback(ticketId: string, message: string): Promise<void> {
  return call("sendFeedback", { ticketId, message });
}

/**
 * An extra indication for a card that is already in flight (the board's note
 * button on a Blocked or Working card). The board writes it into the ticket
 * first, so the flush inside `call` is what makes the run read it; this hands
 * it to an agent that is working right now. It never starts a card the
 * scheduler is deliberately holding back.
 *
 * Resolves false if it never reached the server — the card says so, because an
 * indication nobody received is the person's to send again.
 */
export function noteTicket(ticketId: string, message: string): Promise<boolean> {
  return post("noteTicket", { ticketId, message });
}

/** Approve a ticket in review (or force-complete any ticket). */
export function approveTicket(ticketId: string): void {
  void call("approveTicket", { ticketId });
}

/** Reject a ticket in review with feedback (the board's red cross). */
export function rejectTicket(ticketId: string, message: string): Promise<void> {
  return call("rejectTicket", { ticketId, message });
}

/** Delete tickets. The server owns the ticket set, so this goes through the
 * runs API (which also stops any run on them) rather than the autosave. */
export function removeTickets(ticketIds: string[]): Promise<void> {
  return call("removeTickets", { ticketIds });
}

/** Settle tickets left marked running with no live server run behind them.
 * The server asks its registry, so a genuinely running ticket is never reset;
 * it already does this when it loads a project, which is what makes a stored
 * "running" trustworthy after a restart. */
export function settleZombies(): void {
  void call("settleZombies");
}

async function agentAction(body: object): Promise<boolean> {
  const dir = useStore.getState().projectId;
  if (!dir) return false;
  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, ...body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Queue one message for the project agent, in `mode`; it runs once the
 * turns before it are done. The reply streams back through the live
 * subscription as chat entries; resolves false when the request never got
 * there. */
export async function sendToAgent(mode: Mode, message: string): Promise<boolean> {
  if (!useStore.getState().projectId) return false;
  pokeStream();
  await flushProject();
  return agentAction({ action: "send", mode, message });
}

/** Stop the turn in progress; the queue moves on. */
export function stopAgent(): void {
  void agentAction({ action: "stop" });
}

/** Drop a waiting or failed request, or stop the running one. */
export function cancelRequest(id: string): void {
  void agentAction({ action: "cancel", id });
}

/** Send a failed request again, unchanged. */
export function retryRequest(id: string): void {
  void agentAction({ action: "retry", id });
}
