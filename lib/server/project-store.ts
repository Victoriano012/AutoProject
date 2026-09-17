import { readProject, writeProjectAsync } from "../projects-fs";
import { CHAT_CAP, TICKET_LOG_CAP, type ProjectEvent } from "../project-events";
import { appendHistory, historyRecord, initialHistory, type HistoryRecord } from "./project-history";
export type { ProjectEvent } from "../project-events";
import type {
  ChatEntry,
  LogEntry,
  Project,
  Ticket,
  Worker,
  WorkerPick,
} from "../types";

/**
 * The server process's copy of every open project. Runs live here, so this —
 * not the browser — is the authority on run-produced state, and every write
 * (from a run or from a client PUT) goes through it. Disk writes are debounced;
 * readers always see the in-memory copy, so a run's progress is visible to a
 * client that connects a second later with no tab having been open.
 */

interface Entry {
  project: Project;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(e: ProjectEvent) => void>;
  pending: HistoryRecord[];
  writing: Promise<void> | null;
  generation: number;
  persisted: number;
  error: string | null;
}

// Module state must survive dev hot-reloads, or a recompile would orphan every
// live run's bookkeeping.
const globals = globalThis as unknown as {
  __autoprojectProjects?: Map<string, Entry>;
};
const entries: Map<string, Entry> = (globals.__autoprojectProjects ??= new Map());

const WRITE_DEBOUNCE_MS = 250;

function entry(dir: string): Entry | null {
  const found = entries.get(dir);
  // The map outlives hot reloads, so it can still hold a project loaded by the
  // graph-era (or pre-worker) code; only a fresh read runs the on-disk migration.
  if (found && Array.isArray(found.project.tickets) && Array.isArray(found.project.workers)) {
    // State survives hot reloads from earlier store versions as well.
    found.pending ??= initialHistory(found.project, dir);
    found.writing ??= null;
    found.generation ??= 0;
    found.persisted ??= -1;
    found.error ??= null;
    return found;
  }
  if (found?.timer) clearTimeout(found.timer);
  const project = readProject(dir);
  if (!project) return null;
  const fresh: Entry = {
    project: { ...project, chat: project.chat.slice(-CHAT_CAP), tickets: project.tickets.map((ticket) => ({ ...ticket, log: ticket.log.slice(-TICKET_LOG_CAP) })) },
    timer: null, listeners: found?.listeners ?? new Set(), pending: initialHistory(project, dir),
    writing: null, generation: 0, persisted: -1, error: null,
  };
  entries.set(dir, fresh);
  return fresh;
}

/** True when this call is what pulled the project into memory. */
export function isLoaded(dir: string): boolean {
  return entries.has(dir);
}

export function getProject(dir: string): Project | null {
  return entry(dir)?.project ?? null;
}

export function subscribe(dir: string, fn: (e: ProjectEvent) => void): () => void {
  const e = entry(dir);
  if (!e) return () => {};
  e.listeners.add(fn);
  return () => {
    e.listeners.delete(fn);
  };
}

export function publish(dir: string, event: ProjectEvent): void {
  const e = entries.get(dir);
  if (!e) return;
  for (const fn of [...e.listeners]) fn(event);
}

function persistenceError(dir: string, e: Entry, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to persist project ${dir}: ${message}`);
  if (e.error !== message) {
    e.error = message;
    publish(dir, { type: "persistence", error: message });
  }
}

function scheduleWrite(dir: string, e: Entry): void {
  e.generation++;
  if (e.timer) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    void flush(dir).catch(() => {
      // Keep the dirty generation and journal pending. A subsequent flush or
      // edit retries it; clients receive a persistence event instead of success.
    });
  }, WRITE_DEBOUNCE_MS);
  // A pending durable write must finish before normal process exit.
}

/** Latest background failure, also available to reconnecting clients. */
export function persistenceStatus(dir: string): string | null {
  return entry(dir)?.error ?? null;
}

/** Replace the whole project (a client's autosave, already merged). */
export function setProject(dir: string, project: Project): void {
  const e = entry(dir);
  if (!e) return;
  e.project = project;
  scheduleWrite(dir, e);
}

/** Change one ticket in place. The one place a run-driven status change is
 * stamped: `statusChangedAt` is set here whenever `status` moves, so every
 * writer in runs.ts gets it for free and the columns can order by it. */
export function updateTicket(dir: string, id: string, fn: (t: Ticket) => Ticket): void {
  const e = entry(dir);
  if (!e) return;
  let before: Ticket | null = null;
  let after: Ticket | null = null;
  const tickets = e.project.tickets.map((t) => {
    if (t.id !== id) return t;
    before = t;
    after = fn(t);
    if (after !== t && after.status !== t.status) {
      after = { ...after, statusChangedAt: Date.now() };
    }
    return after;
  });
  if (!before || !after) return;
  const was = before as Ticket;
  const now = after as Ticket;
  if (was === now) return;
  e.project = { ...e.project, tickets };
  scheduleWrite(dir, e);

  const patch: Partial<Ticket> = {};
  const unset: (keyof Ticket)[] = [];
  if (was.status !== now.status) {
    patch.status = now.status;
    patch.statusChangedAt = now.statusChangedAt;
  }
  if (was.sessionId !== now.sessionId) patch.sessionId = now.sessionId;
  if (was.resultSummary !== now.resultSummary) patch.resultSummary = now.resultSummary;
  if (was.stats !== now.stats) patch.stats = now.stats;
  // A stop the person made elsewhere (the toolbar, the ticket panel) reaches
  // the open board this way: without it the card sits in Working saying Queued
  // while the scheduler has quietly parked it.
  if (was.paused !== now.paused) patch.paused = now.paused;
  for (const key of Object.keys(patch) as (keyof Ticket)[]) {
    if (patch[key] === undefined) { unset.push(key); delete patch[key]; }
  }
  if (Object.keys(patch).length > 0 || unset.length) {
    publish(dir, { type: "ticket", id, patch, ...(unset.length ? { unset } : {}) });
  }
}

export function appendLog(dir: string, id: string, entryToAdd: LogEntry): void {
  const e = entry(dir);
  if (!e || !e.project.tickets.some((ticket) => ticket.id === id)) return;
  e.pending.push(historyRecord(entryToAdd, id));
  e.project = {
    ...e.project,
    tickets: e.project.tickets.map((t) =>
      t.id === id ? { ...t, log: [...t.log, entryToAdd].slice(-TICKET_LOG_CAP) } : t
    ),
  };
  scheduleWrite(dir, e);
  publish(dir, { type: "log", id, entries: [entryToAdd] });
}

/** What the planner hands over per ticket: the card's fields and its worker. */
export type PlannedTicket = Pick<Ticket, "title" | "description" | "files"> & {
  worker?: WorkerPick;
};

/** Put new tickets on the board (the project agent's), each on its worker.
 * Returns them with their ids, so the caller can name them in the chat. */
export function addTickets(dir: string, tickets: PlannedTicket[]): Ticket[] {
  const e = entry(dir);
  if (!e || tickets.length === 0) return [];
  const before = e.project.workers;
  let workers = before;
  // The worker the planner named, or a new one — described by the ticket itself
  // when the planner said nothing usable, so no card is ever without a worker.
  const assign = (t: PlannedTicket): string => {
    const pick = t.worker;
    // Two tickets planned in one call can describe the same new worker twice.
    const existing =
      pick &&
      workers.find((w) =>
        "existing" in pick
          ? w.n === pick.existing
          : w.description.toLowerCase() === pick.new.trim().toLowerCase()
      );
    if (existing) return existing.id;
    const w: Worker = {
      id: crypto.randomUUID(),
      n: workers.length + 1,
      description: pick && "new" in pick ? pick.new : t.title,
    };
    workers = [...workers, w];
    return w.id;
  };
  const added: Ticket[] = tickets.map((t) => ({
    id: crypto.randomUUID(),
    title: t.title,
    description: t.description,
    ...(t.files ? { files: t.files } : {}),
    workerId: assign(t),
    status: "todo",
    statusChangedAt: Date.now(),
    log: [],
  }));
  e.project = { ...e.project, workers, tickets: [...e.project.tickets, ...added] };
  scheduleWrite(dir, e);
  // Workers first: a card arriving in a tab must find the worker its badge names.
  if (workers !== before) publish(dir, { type: "workers", workers });
  publish(dir, { type: "tickets", added, removed: [] });
  return added;
}

/** A worker's conversation moved on (its agent reached init on a ticket). */
export function setWorkerSession(dir: string, workerId: string, sessionId: string): void {
  const e = entry(dir);
  const w = e?.project.workers.find((x) => x.id === workerId);
  if (!e || !w || w.sessionId === sessionId) return;
  const workers = e.project.workers.map((x) => (x === w ? { ...x, sessionId } : x));
  e.project = { ...e.project, workers };
  scheduleWrite(dir, e);
  publish(dir, { type: "workers", workers });
}

export function removeTickets(dir: string, ids: string[]): void {
  const e = entry(dir);
  if (!e) return;
  const gone = new Set(ids);
  const removed = e.project.tickets.filter((t) => gone.has(t.id)).map((t) => t.id);
  if (removed.length === 0) return;
  e.project = { ...e.project, tickets: e.project.tickets.filter((t) => !gone.has(t.id)) };
  scheduleWrite(dir, e);
  publish(dir, { type: "tickets", added: [], removed });
}

/** The transcript is bounded: a long act session would otherwise grow
 * project.json (and every snapshot) without limit. */

export function appendChat(dir: string, entries: ChatEntry[]): void {
  const e = entry(dir);
  if (!e || entries.length === 0) return;
  e.pending.push(...entries.map((item) => historyRecord(item)));
  const chat = [...e.project.chat, ...entries];
  e.project = { ...e.project, chat: chat.slice(Math.max(0, chat.length - CHAT_CAP)) };
  scheduleWrite(dir, e);
  publish(dir, { type: "chat", entries });
}

export function setAgentSession(dir: string, sessionId: string | undefined): void {
  const e = entry(dir);
  if (!e || e.project.agentSessionId === sessionId) return;
  e.project = { ...e.project, agentSessionId: sessionId };
  scheduleWrite(dir, e);
  publish(dir, { type: "agent-session", sessionId: sessionId ?? null });
}

export function setNotes(dir: string, notes: string[]): void {
  const e = entry(dir);
  if (!e) return;
  e.project = { ...e.project, notes };
  scheduleWrite(dir, e);
  publish(dir, { type: "notes", notes });
}

/** Persist every change queued before/during this call. Writes for one project
 * never overlap, failures remain dirty, and callers only acknowledge after the
 * journal and atomic snapshot have both reached disk. */
export async function flush(dir: string): Promise<void> {
  const e = entries.get(dir);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (e.writing) {
    await e.writing;
    if (e.persisted < e.generation) await flush(dir);
    return;
  }
  if (e.persisted === e.generation) return;
  const writing = (async () => {
    while (e.persisted < e.generation) {
      const generation = e.generation;
      const project = e.project;
      const pending = e.pending.slice();
      try {
        await appendHistory(dir, pending);
        // The journal is already durable even if the snapshot write fails.
        // Retrying the snapshot must not append these records a second time.
        e.pending.splice(0, pending.length);
        await writeProjectAsync(dir, project);
        e.persisted = generation;
        if (e.error) { e.error = null; publish(dir, { type: "persistence", error: null }); }
      } catch (error) { persistenceError(dir, e, error); throw error; }
    }
  })();
  e.writing = writing;
  try { await writing; } finally { if (e.writing === writing) e.writing = null; }
}

/** Drop only after durable writes finish, so deletion cannot race a timer that
 * recreates its workspace. Run owners must first stop and await their tasks. */
export async function forget(dir: string): Promise<void> {
  await flush(dir);
  discard(dir);
}

/** Drop an idle entry after a successful flush, or deliberately discard it in
 * failure cleanup. Never use this to stop a live project. */
export function discard(dir: string): void {
  const e = entries.get(dir);
  if (e?.writing) throw new Error("Cannot discard a project while it is being saved");
  if (e?.timer) clearTimeout(e.timer);
  entries.delete(dir);
}
