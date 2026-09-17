"use client";

import {
  applyRunState,
  RunStateSnapshot,
  setProjectFlush,
  setStreamPoke,
} from "./runner";
import { useStore } from "./store";
import { mergeRunState, runEdits } from "./run-state";
import {
  AgentRequest,
  ChatEntry,
  LiveSubagent,
  LogEntry,
  Mode,
  Project,
  Ticket,
  Worker,
} from "./types";

async function createOrImport(body: { name?: string; path?: string }) {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = await res.json();
  if (!res.ok) throw new Error(row?.error ?? `Request failed (${res.status})`);
  await openProject(row.id);
  return row.id as string;
}

export const createProject = (name: string) => createOrImport({ name });
export const importProject = (path: string) => createOrImport({ path });

/** `hold` lets the caller keep the picker on screen a moment longer: opening a
 * project from the meta-graph grows its node into the whole view, and the swap
 * belongs at the end of that growth, not whenever the fetch happens to land.
 * The fetch still starts immediately, so the animation costs nothing — if it is
 * the slower of the two, "Loading project…" simply sits behind the box. */
export async function openProject(id: string, hold?: Promise<void>): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) {
    // folder gone or .autoproject deleted — forget it
    useStore.getState().closeProject();
    return;
  }
  const row = await res.json();
  // The server settles anything a dead process left marked running before it
  // answers, so this data is already the truth about what is running.
  base = row.data;
  if (hold) await hold;
  useStore.getState().openProject(id, row.data);
}

/** Persist where a project's node sits on the meta-graph (project picker). */
export async function saveMetaPosition(
  id: string,
  pos: { x: number; y: number }
): Promise<void> {
  const url = `/api/projects/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) return;
  const row = await res.json();
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { ...row.data, metaPosition: pos } }),
  });
}

/** "hide" (default) only removes the project from the meta-graph;
 * "erase" permanently deletes its whole folder from the computer. */
export async function deleteProject(
  id: string,
  mode: "hide" | "erase" = "hide"
): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(id)}?mode=${mode}`, {
    method: "DELETE",
  });
}

// ---- live run feed -------------------------------------------------------

/** The server's `ProjectEvent`s (lib/server/project-store.ts) with `runs`
 * expanded into its snapshot, plus the connection's own two. */
type StreamEvent =
  | { type: "snapshot"; project: Project; runs: RunStateSnapshot }
  | { type: "runs"; runs: RunStateSnapshot }
  | { type: "ticket"; id: string; patch: Partial<Ticket> }
  | { type: "log"; id: string; entries: LogEntry[] }
  | { type: "tickets"; added: Ticket[]; removed: string[] }
  | { type: "chat"; entries: ChatEntry[] }
  | {
      type: "agent";
      busy: boolean;
      mode: Mode | null;
      requests: AgentRequest[];
      subagents: LiveSubagent[];
    }
  | { type: "notes"; notes: string[] }
  | { type: "workers"; workers: Worker[] }
  | { type: "ping" };

const NO_RUNS: RunStateSnapshot = {
  loops: [],
  active: [],
  tickets: [],
  agent: { busy: false, mode: null, requests: [], subagents: [] },
};

let source: EventSource | null = null;
/** The last run snapshot applied, so an `agent` event — which carries only its
 * own part — can be folded into the rest. */
let lastRuns: RunStateSnapshot = NO_RUNS;
/** Timers keeping the feed alive — see `openStream`. */
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastEvent = 0;
/** The last server state applied here — the base a run-field edit is a diff
 * against, so the browser can tell its own deliberate changes (Reopen, a chat
 * session) apart from run output it merely received. */
let base: Project | null = null;
/** Revalidate the feed now — set by `openStream`, called before every action a
 * person takes (see `setStreamPoke`). */
let poke: () => void = () => {};
/** True while applying server state, so autosave does not echo it back. */
let applying = false;

function applyRemote(fn: () => void): void {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

function closeStream(): void {
  if (reopenTimer) clearTimeout(reopenTimer);
  if (watchdog) clearInterval(watchdog);
  reopenTimer = null;
  watchdog = null;
  source?.close();
  source = null;
  setRuns(NO_RUNS);
}

function setRuns(runs: RunStateSnapshot): void {
  lastRuns = runs;
  applyRunState(runs);
}

/** Subscribe to the server's run feed for `dir`: run state, status changes and
 * log lines produced by runs this tab may not have started. EventSource
 * reconnects on its own, and every connection opens with a snapshot, so a
 * reload or a dropped connection catches up in one step. */
function openStream(dir: string): void {
  closeStream();
  if (typeof EventSource === "undefined") return;
  const es = new EventSource(`/api/runs/stream?dir=${encodeURIComponent(dir)}`);
  source = es;
  lastEvent = Date.now();

  // EventSource retries a dropped connection by itself, but not every way a
  // feed dies looks like that. A non-200 — a 404 for a project the server has
  // not loaded, a 500 while the route recompiles — closes it for good; a
  // request aborted mid-stream (dev recompiles the route under an open one)
  // leaves it "connecting" and never comes back; and a connection that dies
  // quietly (sleep, a proxy) just stops delivering with no error at all. Every
  // one of them leaves the tab deaf: statuses stop arriving and only a reload
  // brings it back, which is what "it only moved after I refreshed" looks like.
  // So own the retry — any error reopens the feed, and so does silence, since
  // the server pings every 10s, and so does the person's next click (`poke`).
  // A new connection opens with a snapshot, so one reconnect catches up on
  // everything missed.
  const reconnect = () => {
    if (source !== es) return;
    // Not `closeStream`: the runs are still running, so the run state stays as
    // it was rather than blinking empty until the next snapshot.
    es.close();
    source = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      if (useStore.getState().projectId === dir) openStream(dir);
    }, 2000);
  };
  es.onerror = reconnect;
  poke = () => {
    // A person just asked the server for something and is watching for the
    // answer: no reason to make them wait out the watchdog for a feed that
    // stopped delivering.
    if (source === es && Date.now() - lastEvent > 12_000) reconnect();
  };
  watchdog = setInterval(() => {
    if (Date.now() - lastEvent > 25_000) reconnect();
  }, 5_000);

  es.onmessage = (ev) => {
    if (source !== es) return;
    lastEvent = Date.now();
    let msg: StreamEvent;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const store = useStore.getState();
    if (store.projectId !== dir || !store.projectLoaded) return;
    if (msg.type === "snapshot") {
      // Run fields from the server, the tab's own unsaved edits kept.
      applyRemote(() =>
        useStore.getState().setProject(mergeRunState(store.project, msg.project))
      );
      setRuns(msg.runs);
    } else if (msg.type === "runs") {
      setRuns(msg.runs);
    } else if (msg.type === "agent") {
      setRuns({
        ...lastRuns,
        agent: {
          busy: msg.busy,
          mode: msg.mode,
          requests: msg.requests,
          subagents: msg.subagents,
        },
      });
    } else if (msg.type === "ticket") {
      applyRemote(() => store.updateTicket(msg.id, (t) => ({ ...t, ...msg.patch })));
    } else if (msg.type === "log") {
      applyRemote(() => {
        for (const entry of msg.entries) store.appendLog(msg.id, entry);
      });
    } else if (msg.type === "tickets") {
      applyRemote(() => {
        if (msg.removed.length) store.removeTickets(msg.removed);
        if (msg.added.length) store.addTickets(msg.added);
      });
    } else if (msg.type === "chat") {
      applyRemote(() => store.appendChat(msg.entries));
    } else if (msg.type === "notes") {
      applyRemote(() => store.setNotes(msg.notes));
    } else if (msg.type === "workers") {
      applyRemote(() => store.setProject({ workers: msg.workers }));
    }
  };
}

// ---- autosave ------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
/** On `window`, not in the module: a re-evaluated copy of this module (see the
 * note in store.ts) must not open a second feed and a second autosave beside
 * the ones already running against the same store. */
const live = globalThis as unknown as {
  __autoprojectSync?: { flush: () => Promise<void>; poke: () => void };
};

/** Push the open project now. Run-field changes the person made since the last
 * server state travel as explicit edits; everything else is plain structure. */
async function push(): Promise<void> {
  const { project, projectId, projectLoaded } = useStore.getState();
  if (!projectId || !projectLoaded) return;
  const edits = base ? runEdits(base, project) : [];
  base = project;
  await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: project, edits }),
  }).catch(() => {});
}

/** Flush pending edits before anything that makes the server read the project
 * (starting a run) — the server runs from its own copy, not this tab's. */
export function flushProject(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return push();
}

/** Debounced push of the open project to its .autoproject dir on every change. */
export function startAutosave(): void {
  if (live.__autoprojectSync) {
    // A re-evaluated copy of this module: the feed and the autosave already
    // running own the state, so point the runner back at them instead of
    // starting a second pair beside them.
    setProjectFlush(live.__autoprojectSync.flush);
    setStreamPoke(live.__autoprojectSync.poke);
    return;
  }
  live.__autoprojectSync = { flush: flushProject, poke: () => poke() };
  setProjectFlush(flushProject);
  setStreamPoke(() => poke());
  let prevProject = useStore.getState().project;
  let prevId = useStore.getState().projectId;
  if (prevId) openStream(prevId);

  useStore.subscribe((s) => {
    if (s.projectId !== prevId) {
      prevId = s.projectId;
      prevProject = s.project;
      base = s.projectId ? s.project : null;
      if (s.projectId) openStream(s.projectId);
      else closeStream();
      return;
    }
    if (s.project === prevProject) return;
    prevProject = s.project;
    // Server state, already true on both sides: nothing to push.
    if (applying) {
      base = s.project;
      return;
    }
    if (!s.projectId || !s.projectLoaded) return;
    const id = s.projectId;
    // A deliberate run-field change (Reopen, a chat session) must not sit in a
    // debounce where incoming server state would absorb it.
    if (base && runEdits(base, s.project).length > 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      void push();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (useStore.getState().projectId !== id) return;
      void push();
    }, 1200);
  });
}
