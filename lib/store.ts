"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultProject, type ChatEntry, type LogEntry, type Mode, type Project, type Ticket } from "./types";
import type { SaveState } from "./save-queue";
import { CHAT_CAP, TICKET_LOG_CAP } from "./project-events";
import { zoomOutOfProject } from "./view-zoom";

const navigation = globalThis as unknown as { __autoprojectBeforeClose?: () => Promise<void> };
export function setBeforeProjectClose(fn: () => Promise<void>) { navigation.__autoprojectBeforeClose = fn; }

interface AppState {
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
  /** Server id of the open project; null = show the project picker. */
  projectId: string | null;
  /** True once the open project's data has been fetched from the server. */
  projectLoaded: boolean;
  project: Project;
  selectedId: string | null;
  /** UI state, not persisted: a project always opens on its board. */
  mode: Mode;

  openProject: (id: string, project: Project) => void;
  closeProject: () => void;
  setProject: (p: Partial<Project>) => void;
  select: (id: string | null) => void;
  setMode: (mode: Mode) => void;
  toggleMode: () => void;

  updateTicket: (id: string, fn: (t: Ticket) => Ticket) => void;
  removeTicket: (id: string) => void;
  appendLog: (id: string, entry: LogEntry) => void;
  /** Server-made changes arriving over the live feed (see lib/sync.ts). */
  appendChat: (entries: ChatEntry[]) => void;
  addTickets: (ts: Ticket[]) => void;
  removeTickets: (ids: string[]) => void;
  setNotes: (notes: string[]) => void;
}

const createAppStore = () => create<AppState>()(
  persist(
    (set, get) => ({
      saveState: { status: "saved" },
      setSaveState: (saveState) => set({ saveState }),
      projectId: null,
      projectLoaded: false,
      project: defaultProject("Untitled project"),
      selectedId: null,
      mode: "panel",

      // Re-opening the project the browser is already in — a reload, or a dev
      // HMR update that re-creates this module — keeps the selected card when
      // the server still has it; only a genuinely gone ticket drops it.
      openProject: (id, project) =>
        set((s) => ({
          projectId: id,
          projectLoaded: true,
          project,
          mode: "panel",
          selectedId:
            s.projectId === id && project.tickets.some((t) => t.id === s.selectedId)
              ? s.selectedId
              : null,
        })),
      // The view folds back into the project's node on the meta-graph. The
      // animation owns *when* the state changes, so the commit is handed to it
      // rather than run here.
      closeProject: () => {
        const s = get();
        void (navigation.__autoprojectBeforeClose?.() ?? Promise.resolve()).then(() => {
          if (get().projectId !== s.projectId) return;
          zoomOutOfProject(s.projectId, 0, false, () =>
            set({ projectId: null, projectLoaded: false, selectedId: null, mode: "panel" })
          );
        }).catch((error) => set({ saveState: { status: "error", error: error instanceof Error ? error.message : "Could not save changes" } }));
      },
      setProject: (p) => set((s) => ({ project: { ...s.project, ...p } })),
      select: (id) => set({ selectedId: id }),
      setMode: (mode) => set({ mode }),
      toggleMode: () => set((s) => ({ mode: s.mode === "act" ? "panel" : "act" })),

      updateTicket: (id, fn) =>
        set((s) => ({
          project: {
            ...s.project,
            tickets: s.project.tickets.map((t) => (t.id === id ? fn(t) : t)),
          },
        })),

      removeTicket: (id) => get().removeTickets([id]),

      appendLog: (id, entry) =>
        set((s) => ({
          project: {
            ...s.project,
            tickets: s.project.tickets.map((t) =>
              t.id === id ? { ...t, log: [...t.log, entry].slice(-TICKET_LOG_CAP) } : t
            ),
          },
        })),

      appendChat: (entries) =>
        set((s) => ({ project: { ...s.project, chat: [...s.project.chat, ...entries].slice(-CHAT_CAP) } })),

      // A ticket the browser already has (its own optimistic copy, or a replayed
      // event) is replaced rather than duplicated.
      addTickets: (ts) =>
        set((s) => {
          const ids = new Set(ts.map((t) => t.id));
          return {
            project: {
              ...s.project,
              tickets: [...s.project.tickets.filter((t) => !ids.has(t.id)), ...ts],
            },
          };
        }),

      removeTickets: (ids) =>
        set((s) => ({
          selectedId: s.selectedId && ids.includes(s.selectedId) ? null : s.selectedId,
          project: {
            ...s.project,
            tickets: s.project.tickets.filter((t) => !ids.includes(t.id)),
          },
        })),

      setNotes: (notes) => set((s) => ({ project: { ...s.project, notes } })),
    }),
    {
      name: "autoproject-project",
      storage: createJSONStorage(() => {
        let previous: string | null = null;
        return {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => { if (value !== previous) { localStorage.setItem(key, value); previous = value; } },
          removeItem: (key) => { localStorage.removeItem(key); previous = null; },
        };
      }),
      // Project data lives on the server; only remember which project is open
      // and which card was pressed — `openProject` re-validates that against
      // the tickets it fetches before restoring it.
      partialize: (s) => ({ projectId: s.projectId, selectedId: s.selectedId }),
    }
  )
);

/**
 * One store per window, kept across module re-evaluations.
 *
 * `next dev` re-evaluates this module whenever anything it imports changes —
 * which, in a repo where agents are editing the app while it is open, is all
 * the time. A second store would be a *different* store: the mounted
 * components would switch to it empty, so the open project reads as unloaded
 * and the whole view blinks back through "Loading project…" — the board and
 * everything typed into it gone for no reason the person can see — while the
 * live feed carries on writing statuses into the store nobody is rendering,
 * leaving the tab deaf until a reload. Reusing the one on `window` makes a
 * refresh of the code just that.
 */
const win =
  typeof window === "undefined"
    ? null
    : (window as unknown as { __autoprojectStore?: ReturnType<typeof createAppStore> });
export const useStore = win?.__autoprojectStore ?? createAppStore();
if (win) win.__autoprojectStore = useStore;
