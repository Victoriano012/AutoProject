import { hasProjectChanges, overlayProjectPatch, projectChanges, sameValue, type FieldEdit, type ProjectPatch } from "./project-edits";
import { mergeRunState } from "./run-state";
import type { Project } from "./types";

export interface SaveState { status: "saved" | "pending" | "saving" | "error"; error?: string }
export class SaveConflict extends Error {
  readonly remote: Project;
  constructor(message: string, remote: Project) { super(message); this.name = "SaveConflict"; this.remote = remote; }
}
interface SaveEntry {
  base: Project;
  remote: Project;
  local: Project;
  state: SaveState;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  blocked?: boolean;
  received: number;
  conflictRemote?: Project;
  // Only edit() writes these: streamed changes must never become local intent.
  inFlightChanges?: Map<string, FieldEdit>;
  inFlightEdits?: Map<string, ProjectPatch["edits"][number]>;
}
interface QueueOptions {
  send: (id: string, patch: ProjectPatch) => Promise<Project>;
  changed?: (id: string, project: Project, state: SaveState, pending: ProjectPatch) => void;
  delay?: number;
}

/** Each project has one ordered writer. Acknowledgement, not dispatch, clears dirt. */
export class ProjectSaveQueue {
  private entries = new Map<string, SaveEntry>();
  private options: QueueOptions;
  constructor(options: QueueOptions) { this.options = options; }
  configure(options: QueueOptions) { this.options = options; }
  seed(id: string, remote: Project, recovered?: ProjectPatch): Project {
    const existing = this.entries.get(id);
    if (existing) return this.receive(id, remote);
    const entry: SaveEntry = { base: remote, remote, local: recovered ? overlayProjectPatch(remote, recovered) : remote, state: { status: "saved" }, received: 0 };
    // Recovered drafts keep their original comparison values until resolved.
    if (recovered) {
      const inverse = { ...recovered, edits: [], changes: recovered.changes.map((c) => ({ ...c, value: c.before })) };
      entry.base = overlayProjectPatch(remote, inverse);
      entry.base = { ...entry.base, tickets: entry.base.tickets.map((t) => {
        const edit = recovered.edits.find((e) => e.id === t.id);
        return edit ? { ...t, status: edit.before } : t;
      }) };
      entry.state = { status: "pending" };
    }
    this.entries.set(id, entry);
    this.notify(id, entry);
    return entry.local;
  }
  remote(id: string) { return this.entries.get(id)?.remote; }
  base(id: string) { return this.entries.get(id)?.base; }
  current(id: string) { return this.entries.get(id)?.local; }
  state(id: string): SaveState { return this.entries.get(id)?.state ?? { status: "saved" }; }
  pending(id: string) {
    const e = this.entries.get(id);
    return e ? projectChanges(e.base, e.local) : undefined;
  }
  receive(id: string, remote: Project): Project {
    const e = this.entries.get(id);
    if (!e) return this.seed(id, remote);
    e.remote = remote;
    const pending = projectChanges(e.base, e.local);
    e.local = overlayProjectPatch(remote, pending);
    // Keep original comparison values for dirty fields: a live update must
    // not silently authorize overwriting another tab's same-field edit.
    e.base = overlayProjectPatch(remote, { ...pending, edits: [], changes: pending.changes.map((c) => ({ ...c, value: c.before })) });
    if (pending.edits.length) e.base = { ...e.base, tickets: e.base.tickets.map((t) => {
      const edit = pending.edits.find((v) => v.id === t.id);
      return edit ? { ...t, status: edit.before } : t;
    }) };
    e.received++;
    this.notify(id, e);
    return e.local;
  }
  edit(id: string, project: Project) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Project has not loaded yet.");
    if (e.inFlightChanges && e.inFlightEdits) {
      const delta = projectChanges(e.local, project);
      for (const change of delta.changes) {
        const key = change.scope === "project" ? `project:${change.field}` : `ticket:${change.id}:${change.field}`;
        const prior = e.inFlightChanges.get(key);
        const combined = { ...change, before: prior ? prior.before : change.before };
        if (sameValue(combined.before, combined.value)) e.inFlightChanges.delete(key);
        else e.inFlightChanges.set(key, combined);
      }
      for (const edit of delta.edits) {
        const prior = e.inFlightEdits.get(edit.id);
        e.inFlightEdits.set(edit.id, { ...edit, before: prior?.before ?? edit.before });
      }
    }
    e.local = project;
    if (!e.blocked) {
      e.state = { status: "pending" };
      if (e.timer) clearTimeout(e.timer);
      e.timer = setTimeout(() => { e.timer = undefined; void this.flush(id).catch(() => {}); }, this.options.delay ?? 500);
    }
    this.notify(id, e);
  }
  async flush(id: string, retry = false): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    if (retry) {
      e.blocked = false;
      if (e.conflictRemote) { e.base = e.remote; e.conflictRemote = undefined; }
    }
    if (e.blocked) throw new Error(e.state.error ?? "Changes have not been saved.");
    if (e.flight) { await e.flight; return this.flush(id); }
    const patch = projectChanges(e.base, e.local);
    if (!hasProjectChanges(patch)) { e.state = { status: "saved" }; this.notify(id, e); return; }
    e.inFlightChanges = new Map();
    e.inFlightEdits = new Map();
    const received = e.received;
    e.state = { status: "saving" };
    this.notify(id, e);
    e.flight = (async () => {
      try {
        const remote = await this.options.send(id, patch);
        const outstanding: ProjectPatch = { revision: remote.revision ?? 0,
          changes: [...e.inFlightChanges!.values()], edits: [...e.inFlightEdits!.values()] };
        // A delayed HTTP acknowledgement cannot roll back a later server edit.
        // Run events need no revision increment, so retain the latest streamed
        // run fields independently of the revision used for user edits.
        const newer = e.received !== received && (e.remote.revision ?? 0) >= (remote.revision ?? 0);
        let acknowledged = newer ? e.remote : remote;
        if (e.received !== received) {
          acknowledged = { ...mergeRunState(acknowledged, e.remote),
            revision: Math.max(remote.revision ?? 0, e.remote.revision ?? 0) };
          // If the stream still predates an explicit Reopen, its old status
          // cannot undo that acknowledged intent. Later run output still wins.
          if (!newer && (e.remote.revision ?? 0) < (remote.revision ?? 0)) {
            acknowledged = { ...acknowledged, tickets: acknowledged.tickets.map((t) => {
              const edit = patch.edits.find((v) => v.id === t.id);
              const saved = remote.tickets.find((v) => v.id === t.id);
              return edit && saved && t.status === edit.before
                ? { ...t, status: saved.status, statusChangedAt: saved.statusChangedAt } : t;
            }) };
          }
        }
        e.remote = acknowledged;
        e.base = overlayProjectPatch(acknowledged, { ...outstanding, edits: [],
          changes: outstanding.changes.map((change) => ({ ...change, value: change.before })) });
        if (outstanding.edits.length) e.base = { ...e.base, tickets: e.base.tickets.map((t) => {
          const edit = outstanding.edits.find((v) => v.id === t.id);
          return edit ? { ...t, status: edit.before } : t;
        }) };
        e.local = overlayProjectPatch(acknowledged, outstanding);
        e.state = { status: hasProjectChanges(projectChanges(e.base, e.local)) ? "pending" : "saved" };
      } catch (error) {
        // The queue survives HMR, while an Error constructor does not.
        if (error instanceof Error && error.name === "SaveConflict" && "remote" in error) {
          const remote = (error as SaveConflict).remote;
          this.receive(id, remote); e.conflictRemote = remote;
        }
        e.blocked = true;
        e.state = { status: "error", error: error instanceof Error ? error.message : "Could not save changes." };
        throw error;
      } finally {
        e.inFlightChanges = undefined;
        e.inFlightEdits = undefined;
        e.flight = undefined;
        this.notify(id, e);
      }
    })();
    await e.flight;
    if (hasProjectChanges(projectChanges(e.base, e.local))) await this.flush(id);
  }
  private notify(id: string, e: SaveEntry) { this.options.changed?.(id, e.local, e.state, projectChanges(e.base, e.local)); }
}
