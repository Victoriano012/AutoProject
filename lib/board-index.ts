import type { FileClaim, Ticket } from "./types";

/** Resolve harmless spelling differences without resolving symlinks or case. */
export function normalizeFile(file: string): string {
  const parts: string[] = [];
  const absolute = file.trim().startsWith("/");
  for (const part of file.trim().replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export interface FileBlockee { file: string; files: string[]; who: Ticket }

/** Build all relationships together. Cost is proportional to declared files
 * and actual conflicting pairs; unrelated cards never scan one another. */
export function createBoardIndex(tickets: readonly Ticket[]) {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const order = new Map(tickets.map((t, i) => [t.id, i]));
  const filesByTicket = new Map<string, string[]>();
  const holdersByFile = new Map<string, Ticket[]>();
  const holdersByWorker = new Map<string, Ticket[]>();
  const claimsByTicket = new Map<string, FileClaim[]>();
  const blockeesByTicket = new Map<string, FileBlockee[]>();
  const busyWorkerByTicket = new Map<string, Ticket>();
  for (const t of tickets) {
    const files = [...new Set((t.files ?? []).map(normalizeFile).filter(Boolean))].sort();
    filesByTicket.set(t.id, files);
    claimsByTicket.set(t.id, []);
    blockeesByTicket.set(t.id, []);
    if (t.status !== "running") continue;
    for (const file of files) {
      const holders = holdersByFile.get(file) ?? [];
      holders.push(t);
      holdersByFile.set(file, holders);
    }
    if (t.workerId) {
      const holders = holdersByWorker.get(t.workerId) ?? [];
      holders.push(t);
      holdersByWorker.set(t.workerId, holders);
    }
  }
  for (const t of tickets) {
    const worker = t.workerId && holdersByWorker.get(t.workerId)?.find((other) => other.id !== t.id);
    if (worker) busyWorkerByTicket.set(t.id, worker);
    if (t.status === "done") continue;
    const shared = new Map<string, string[]>();
    for (const file of filesByTicket.get(t.id)!) {
      for (const holder of holdersByFile.get(file) ?? []) {
        if (holder.id === t.id) continue;
        const files = shared.get(holder.id) ?? [];
        files.push(file);
        shared.set(holder.id, files);
      }
    }
    const claims = [...shared].sort(([a], [b]) => order.get(a)! - order.get(b)!)
      .map(([id, files]) => ({ file: files[0], files, by: ticketById.get(id)! }));
    claimsByTicket.set(t.id, claims);
    if (t.status !== "running" && t.status !== "review") {
      for (const claim of claims) {
        blockeesByTicket.get(claim.by.id)!.push({ file: claim.file, files: claim.files, who: t });
      }
    }
  }
  return {
    ticketById, claimsByTicket, blockeesByTicket, busyWorkerByTicket,
    fileHolders: (id: string): FileClaim[] => claimsByTicket.get(id) ?? [],
    fileBlockees: (id: string): FileBlockee[] => blockeesByTicket.get(id) ?? [],
    workerBusyOn: (id: string): Ticket | null => busyWorkerByTicket.get(id) ?? null,
  };
}
export type BoardIndex = ReturnType<typeof createBoardIndex>;

const NO_LOG: Ticket["log"] = [];
/** Stable board metadata across streamed log/session/stat updates. Each board
 * owns a selector so switching projects cannot reuse another board's cache. */
export function createBoardTicketSelector() {
  let source: Ticket[] | undefined;
  let result: Ticket[] = [];
  return (state: { project: { tickets: Ticket[] } }): Ticket[] => {
    const tickets = state.project.tickets;
    if (source === tickets) return result;
    source = tickets;
    const previous = new Map(result.map((t) => [t.id, t]));
    const next = tickets.map((t) => {
      const old = previous.get(t.id);
      if (old && old.title === t.title && old.description === t.description &&
        old.status === t.status && old.statusChangedAt === t.statusChangedAt &&
        old.files === t.files && old.workerId === t.workerId && old.paused === t.paused) return old;
      return { id: t.id, title: t.title, description: t.description, status: t.status,
        statusChangedAt: t.statusChangedAt, files: t.files, workerId: t.workerId,
        paused: t.paused, log: NO_LOG };
    });
    if (next.length !== result.length || next.some((t, i) => t !== result[i])) result = next;
    return result;
  };
}
