"use client";

import { applyRunState, type RunStateSnapshot, setProjectFlush, setStreamPoke } from "./runner";
import { setBeforeProjectClose, useStore } from "./store";
import { projectChanges, hasProjectChanges, type ProjectPatch } from "./project-edits";
import { ProjectSaveQueue, SaveConflict } from "./save-queue";
import { reduceProjectEvent } from "./project-events";
import type { ProjectEvent } from "./project-events";
import type { Project } from "./types";

async function sendPatch(id: string, patch: ProjectPatch): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (res.status === 409 && body.data) throw new SaveConflict(body.error, body.data);
  if (!res.ok) throw new Error(body.error ?? `Could not save (${res.status})`);
  return body.data;
}

const draftKey = (id: string) => `autoproject-draft:${id}`;
const session = globalThis as unknown as { __autoprojectSaves?: ProjectSaveQueue };
const saves = session.__autoprojectSaves ?? new ProjectSaveQueue({ send: sendPatch });
if (typeof window !== "undefined") session.__autoprojectSaves = saves;
saves.configure({
  send: sendPatch,
  changed(id, project, state, pending) {
    if (typeof sessionStorage !== "undefined") {
      try {
        if (hasProjectChanges(pending)) sessionStorage.setItem(draftKey(id), JSON.stringify(pending));
        else sessionStorage.removeItem(draftKey(id));
      } catch { /* Large drafts remain in memory and keep the unload warning. */ }
    }
    const store = useStore.getState();
    if (store.projectId !== id || !store.projectLoaded) return;
    applyRemote(() => { if (store.project !== project) store.setProject(project); store.setSaveState(state); });
  },
});

async function createOrImport(body: { name?: string; path?: string }) {
  const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const row = await res.json();
  if (!res.ok) throw new Error(row?.error ?? `Request failed (${res.status})`);
  await openProject(row.id);
  return row.id as string;
}
export const createProject = (name: string) => createOrImport({ name });
export const importProject = (path: string) => createOrImport({ path });

let openGeneration = 0;
export async function openProject(id: string, hold?: Promise<void>): Promise<void> {
  const generation = ++openGeneration;
  await flushProject();
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Could not open project (${res.status})`);
  const row = await res.json();
  if (hold) await hold;
  if (generation !== openGeneration) return;
  let recovered: ProjectPatch | undefined;
  try { recovered = JSON.parse(sessionStorage.getItem(draftKey(id)) ?? "null") ?? undefined; } catch { /* No recoverable draft. */ }
  const project = saves.seed(id, row.data, recovered);
  applyRemote(() => { useStore.getState().openProject(id, project); useStore.getState().setSaveState(saves.state(id)); });
  openStream(id);
  if (recovered) void saves.flush(id).catch(() => {});
}

export async function saveMetaPosition(id: string, pos: { x: number; y: number }): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Could not load project position.");
  const { data } = await res.json();
  await sendPatch(id, projectChanges(data, { ...data, metaPosition: pos }));
}
export async function deleteProject(id: string, mode: "hide" | "erase" = "hide"): Promise<void> {
  await saves.flush(id);
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}?mode=${mode}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).error ?? "Could not remove project.");
}

type StreamEvent = Exclude<ProjectEvent, { type: "runs" }>
  | { type: "snapshot"; project: Project; runs: RunStateSnapshot }
  | { type: "runs"; runs: RunStateSnapshot }
  | { type: "ping" };
const NO_RUNS: RunStateSnapshot = { loops: [], active: [], tickets: [], agent: { busy: false, mode: null, requests: [], subagents: [] } };

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
      saves.receive(dir, msg.project);
      setRuns(msg.runs);
    } else if (msg.type === "runs") {
      setRuns(msg.runs);
    } else if (msg.type === "agent") {
      setRuns({ ...lastRuns, agent: { busy: msg.busy, mode: msg.mode, requests: msg.requests, subagents: msg.subagents } });
    } else if (msg.type === "persistence") {
      if (msg.error) store.setSaveState({ status: "error", error: msg.error });
      else store.setSaveState(saves.state(dir));
    } else if (msg.type !== "ping") {
      const remote = saves.remote(dir);
      if (remote) saves.receive(dir, reduceProjectEvent(remote, msg));
    }
  };
}

export function flushProject(): Promise<void> {
  const { projectId, projectLoaded } = useStore.getState();
  return projectId && projectLoaded ? saves.flush(projectId) : Promise.resolve();
}
export async function retrySave(): Promise<void> {
  const id = useStore.getState().projectId;
  if (!id) return;
  await saves.flush(id, true);
  // A background disk failure can happen without local edits to resend.
  const project = await sendPatch(id, { revision: saves.base(id)?.revision ?? 0, changes: [], edits: [] });
  saves.receive(id, project);
}

const live = globalThis as unknown as { __autoprojectSync?: { dispose: () => void } };
export function startAutosave(): void {
  live.__autoprojectSync?.dispose();
  setProjectFlush(flushProject);
  setBeforeProjectClose(flushProject);
  setStreamPoke(() => poke());
  let prevProject = useStore.getState().project;
  let prevId = useStore.getState().projectId;
  if (prevId && useStore.getState().projectLoaded) { if (!saves.base(prevId)) saves.seed(prevId, prevProject); openStream(prevId); }
  const unsubscribe = useStore.subscribe((s) => {
    if (s.projectId !== prevId) {
      prevId = s.projectId;
      prevProject = s.project;
      if (s.projectId && s.projectLoaded) { if (!saves.base(s.projectId)) saves.seed(s.projectId, s.project); openStream(s.projectId); }
      else closeStream();
      return;
    }
    if (s.project === prevProject) return;
    prevProject = s.project;
    if (applying || !s.projectId || !s.projectLoaded) return;
    if (!saves.base(s.projectId)) saves.seed(s.projectId, s.project);
    saves.edit(s.projectId, s.project);
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    const id = useStore.getState().projectId;
    if (id && hasProjectChanges(saves.pending(id) ?? { revision: 0, changes: [], edits: [] })) {
      event.preventDefault(); event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);
  live.__autoprojectSync = { dispose() { unsubscribe(); closeStream(); window.removeEventListener("beforeunload", beforeUnload); } };
}
