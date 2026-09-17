import type { AgentRequest, LiveSubagent, Mode, Ticket } from "../types";

/**
 * The run registry: agent runs execute here, in the server process, so they
 * outlive the browser tab that started them. Per-ticket entries are keyed by
 * `ticketKey(dir, id)`, per-project ones by the project dir. It does not
 * survive a server restart — a fresh process settles whatever project.json
 * still says is running (see settleZombies).
 */
export interface Registry {
  claims: Map<string, { dir: string; ticket: Ticket; done: Promise<void>; release: () => void }>;
  removing: Set<string>;
  agentTasks: Map<string, Promise<void>>;
  loopTasks: Map<string, Promise<void>>;
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
  /** The subagents that turn has running, oldest first. */
  subagents: Map<string, LiveSubagent[]>;
  /** Messages for the project agent, by dir, in the order they were sent: the
   * one running first, then the ones waiting, with failed ones left in place. */
  requests: Map<string, AgentRequest[]>;
  /** Hands a message to the project agent's live turn (see AgentEvent "input"),
   * by dir; absent while it runs on a CLI that cannot take one mid-turn. */
  inputs: Map<string, (text: string) => boolean>;
}

const globals = globalThis as unknown as { __autoprojectRegistry?: Registry };
export const registry: Registry = (globals.__autoprojectRegistry ??= {
  claims: new Map(),
  removing: new Set(),
  agentTasks: new Map(),
  loopTasks: new Map(),
  controllers: new Map(),
  active: new Set(),
  loops: new Set(),
  userStopped: new Set(),
  pendingFeedback: new Map(),
  notes: new Map(),
  wakes: new Map(),
  agents: new Map(),
  agentMode: new Map(),
  subagents: new Map(),
  requests: new Map(),
  inputs: new Map(),
});
// A dev-server hot reload keeps the old registry object, which predates these.
registry.pendingFeedback ??= new Map();
registry.notes ??= new Map();
registry.wakes ??= new Map();
registry.agents ??= new Map();
registry.agentMode ??= new Map();
registry.subagents ??= new Map();
registry.requests ??= new Map();
registry.inputs ??= new Map();

registry.claims ??= new Map();
registry.removing ??= new Set();
registry.agentTasks ??= new Map();
registry.loopTasks ??= new Map();

export const ticketKey = (dir: string, id: string) => dir + "\u0000" + id;
