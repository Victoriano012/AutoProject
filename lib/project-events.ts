import type { AgentRequest, ChatEntry, LiveSubagent, LogEntry, Mode, Project, Ticket, Worker } from "./types";

/** Wire contract shared by the server feed and browser. Optional fields are
 * removed explicitly because JSON omits values set to undefined. */
export type ProjectEvent =
  | { type: "project"; project: Project }
  | { type: "ticket"; id: string; patch: Partial<Ticket>; unset?: (keyof Ticket)[] }
  | { type: "log"; id: string; entries: LogEntry[] }
  | { type: "tickets"; added: Ticket[]; removed: string[] }
  | { type: "chat"; entries: ChatEntry[] }
  | { type: "agent"; busy: boolean; mode: Mode | null; requests: AgentRequest[]; subagents: LiveSubagent[] }
  | { type: "agent-session"; sessionId: string | null }
  | { type: "persistence"; error: string | null }
  | { type: "notes"; notes: string[] }
  | { type: "workers"; workers: Worker[] }
  | { type: "runs" };

export const TICKET_LOG_CAP = 1000;
export const CHAT_CAP = 2000;

/** Reduce a wire event against server state before rebasing unsaved user edits. */
export function reduceProjectEvent(project: Project, event: ProjectEvent): Project {
  switch (event.type) {
    case "project": return event.project;
    case "ticket": return { ...project, tickets: project.tickets.map((ticket) => {
      if (ticket.id !== event.id) return ticket;
      const next = { ...ticket, ...event.patch };
      for (const key of event.unset ?? []) delete next[key];
      return next;
    }) };
    case "log": return { ...project, tickets: project.tickets.map((t) => t.id === event.id ? { ...t, log: [...t.log, ...event.entries].slice(-TICKET_LOG_CAP) } : t) };
    case "chat": return { ...project, chat: [...project.chat, ...event.entries].slice(-CHAT_CAP) };
    case "tickets": {
      const removed = new Set(event.removed);
      const added = new Set(event.added.map((t) => t.id));
      return { ...project, tickets: [...project.tickets.filter((t) => !removed.has(t.id) && !added.has(t.id)), ...event.added] };
    }
    case "agent-session": return { ...project, agentSessionId: event.sessionId ?? undefined };
    case "notes": return { ...project, notes: event.notes };
    case "workers": return { ...project, workers: event.workers };
    default: return project;
  }
}
