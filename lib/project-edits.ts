import type { Project, TicketStatus } from "./types";

export const PROJECT_FIELDS = ["name", "description", "workspaceDir", "attachments", "notes", "metaPosition"] as const;
export const TICKET_FIELDS = ["title", "description", "files", "attachments", "paused"] as const;
export type ProjectField = typeof PROJECT_FIELDS[number];
export type TicketField = typeof TICKET_FIELDS[number];
export type FieldEdit =
  | { scope: "project"; field: ProjectField; before: unknown; value: unknown }
  | { scope: "ticket"; id: string; field: TicketField; before: unknown; value: unknown };
export interface ProjectPatch {
  revision: number;
  changes: FieldEdit[];
  edits: { id: string; before: TicketStatus; status: "todo" }[];
}
const wire = (value: unknown) => value === undefined ? null : value;
export const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(wire(a)) === JSON.stringify(wire(b));

/** Only user-edited fields travel back to the server, never logs or sessions. */
export function projectChanges(base: Project, next: Project): ProjectPatch {
  const changes: FieldEdit[] = [];
  for (const field of PROJECT_FIELDS) {
    if (!sameValue(base[field], next[field])) changes.push({ scope: "project", field, before: wire(base[field]), value: wire(next[field]) });
  }
  const previous = new Map(base.tickets.map((t) => [t.id, t]));
  const edits: ProjectPatch["edits"] = [];
  for (const ticket of next.tickets) {
    const before = previous.get(ticket.id);
    if (!before) continue;
    for (const field of TICKET_FIELDS) {
      if (!sameValue(before[field], ticket[field])) changes.push({ scope: "ticket", id: ticket.id, field, before: wire(before[field]), value: wire(ticket[field]) });
    }
    if (before.status !== ticket.status && ticket.status === "todo") edits.push({ id: ticket.id, before: before.status, status: "todo" });
  }
  return { revision: base.revision ?? 0, changes, edits };
}
export const hasProjectChanges = (patch: ProjectPatch) => patch.changes.length > 0 || patch.edits.length > 0;

export class EditConflict extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`These fields changed elsewhere: ${fields.join(", ")}. Your edits have been kept.`);
    this.fields = fields;
  }
}

/** Compare the touched fields, so another tab's unrelated edits remain intact. */
export function applyProjectPatch(current: Project, patch: ProjectPatch, owned: (id: string) => boolean = () => false): Project {
  const conflicts: string[] = [];
  const tickets = new Map(current.tickets.map((t) => [t.id, t]));
  for (const change of patch.changes) {
    const target = change.scope === "project" ? current : tickets.get(change.id);
    const actual = target && (target as unknown as Record<string, unknown>)[change.field];
    if (!target || (!sameValue(actual, change.before) && !sameValue(actual, change.value))) conflicts.push(change.scope === "project" ? change.field : `${change.id}.${change.field}`);
  }
  for (const edit of patch.edits) {
    const target = tickets.get(edit.id);
    if (!target || owned(edit.id) || (target.status !== edit.before && target.status !== edit.status)) conflicts.push(`${edit.id}.status`);
  }
  if (conflicts.length) throw new EditConflict(conflicts);
  return overlayProjectPatch(current, patch, true);
}

/** Overlay local intent on a newer server snapshot without reviving removed cards. */
export function overlayProjectPatch(current: Project, patch: ProjectPatch, increment = false): Project {
  let next = current;
  const tickets = new Map(current.tickets.map((t) => [t.id, t]));
  for (const change of patch.changes) {
    const value = change.value === null ? undefined : change.value;
    if (change.scope === "project") { if (!sameValue(next[change.field], value)) next = { ...next, [change.field]: value }; }
    else {
      const ticket = tickets.get(change.id);
      if (ticket && !sameValue(ticket[change.field], value)) tickets.set(change.id, { ...ticket, [change.field]: value });
    }
  }
  for (const edit of patch.edits) {
    const ticket = tickets.get(edit.id);
    if (ticket && ticket.status !== edit.status) tickets.set(edit.id, { ...ticket, status: edit.status, ...(increment ? { statusChangedAt: Date.now() } : {}) });
  }
  const updated = current.tickets.map((t) => tickets.get(t.id)!);
  if (updated.some((t, i) => t !== current.tickets[i])) next = { ...next, tickets: updated };
  return increment && next !== current ? { ...next, revision: (current.revision ?? 0) + 1 } : next;
}
