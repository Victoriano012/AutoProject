import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import type { ChatEntry, LogEntry, Project } from "../types";

export interface HistoryRecord {
  id: string;
  ticketId?: string;
  entry: LogEntry | ChatEntry;
}

const dataDir = (dir: string) => path.join(dir, ".autoproject");
const historyFile = (dir: string) => path.join(dataDir(dir), "history.jsonl");
const versionFile = (dir: string) => path.join(dataDir(dir), "history.version");
const seededFile = (dir: string) => path.join(dataDir(dir), "history.seeded");

export function historyRecord(entry: LogEntry | ChatEntry, ticketId?: string): HistoryRecord {
  // Each occurrence has its own ID; a retried queued record keeps that ID.
  return { id: randomUUID(), ...(ticketId ? { ticketId } : {}), entry };
}

export function initialHistory(project: Project, dir: string): HistoryRecord[] {
  if (existsSync(seededFile(dir))) return [];
  // Stable sequence IDs make interrupted initial migrations retryable without
  // merging distinct occurrences of identical messages.
  const seed = (entry: LogEntry | ChatEntry, index: number, ticketId?: string) => ({
    ...historyRecord(entry, ticketId),
    id: createHash("sha256").update(JSON.stringify([ticketId ?? null, index, entry])).digest("hex"),
  });
  return [
    ...project.chat.map((entry, index) => seed(entry, index)),
    ...project.tickets.flatMap((ticket) => ticket.log.map((entry, index) => seed(entry, index, ticket.id))),
  ];
}

/** Decode complete JSONL records at byte boundaries. A single unusually long
 * message may cross many 64KB chunks; join its pieces only once. */
async function* journalLines(dir: string, start = 0) {
  const input = createReadStream(historyFile(dir), { start });
  let offset = start;
  let pieces: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const buffer = chunk as Buffer;
      let from = 0;
      for (;;) {
        const newline = buffer.indexOf(10, from);
        if (newline < 0) {
          if (from < buffer.length) { pieces.push(buffer.subarray(from)); size += buffer.length - from; }
          break;
        }
        const part = buffer.subarray(from, newline);
        const bytes = pieces.length ? Buffer.concat([...pieces, part], size + part.length) : part;
        const end = offset + size + part.length + 1;
        yield { bytes, start: offset, end };
        offset = end;
        pieces = [];
        size = 0;
        from = newline + 1;
      }
    }
    // An unterminated tail may be an interrupted write. It is not a committed
    // record; the next append begins with a newline so it cannot swallow data.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { input.destroy(); }
}

function parseRecord(bytes: Buffer): HistoryRecord | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<HistoryRecord>;
    return typeof record.id === "string" && record.entry && typeof record.entry.text === "string"
      ? record as HistoryRecord : null;
  } catch { return null; }
}

async function writeMarker(file: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile("2\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Older journals could repeat a successfully appended batch when its snapshot
 * failed. Migrate once using an on-disk ID set, so neither migration nor paging
 * needs memory proportional to the full transcript. Atomic replacement also
 * makes the initial project-log migration safe to resume after a crash. */
async function compactHistory(dir: string, extra: HistoryRecord[] = [], seed = false): Promise<void> {
  await fs.mkdir(dataDir(dir), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(dataDir(dir), ".history-migration-"));
  const outputPath = path.join(temporary, "history.jsonl");
  const output = await fs.open(outputPath, "wx", 0o600);
  try {
    const appendUnique = async (record: HistoryRecord) => {
      const key = createHash("sha256").update(record.id).digest("hex");
      try { await fs.mkdir(path.join(temporary, key)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
      await output.writeFile(JSON.stringify(record) + "\n");
    };
    for await (const line of journalLines(dir)) {
      const record = parseRecord(line.bytes);
      if (record) await appendUnique(record);
    }
    for (const record of extra) await appendUnique(record);
    await output.sync();
    await output.close();
    await fs.rename(outputPath, historyFile(dir));
    await writeMarker(versionFile(dir));
    if (seed) await writeMarker(seededFile(dir));
  } finally {
    await output.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const migrations = new Map<string, Promise<void>>();
async function ensureCurrentFormat(dir: string): Promise<void> {
  if (existsSync(versionFile(dir))) return;
  const existing = migrations.get(dir);
  if (existing) return existing;
  const migrating = compactHistory(dir);
  migrations.set(dir, migrating);
  try { await migrating; } finally { migrations.delete(dir); }
}

/** The store serializes calls and removes records from its queue immediately
 * after this succeeds, independently of its subsequent snapshot write. */
export async function appendHistory(dir: string, records: HistoryRecord[]): Promise<void> {
  if (!records.length) return;
  await ensureCurrentFormat(dir);
  if (!existsSync(seededFile(dir))) {
    await compactHistory(dir, records, true);
    return;
  }
  const file = await fs.open(historyFile(dir), "a", 0o600);
  const originalSize = (await file.stat()).size;
  try {
    await file.writeFile("\n" + records.map((record) => JSON.stringify(record) + "\n").join(""));
    await file.sync();
  } catch (error) {
    // A partial failed append must not be duplicated by the next retry.
    await file.truncate(originalSize);
    await file.sync();
    throw error;
  } finally { await file.close(); }
}

/** The numeric cursor is an opaque UTF-8 byte position. Each page starts there
 * directly, so exporting N records costs O(N) reads with bounded page memory. */
export async function readProjectHistory(
  dir: string,
  options: { ticketId?: string; cursor?: number; limit?: number } = {},
): Promise<{ entries: (LogEntry | ChatEntry)[]; nextCursor: number | null }> {
  await ensureCurrentFormat(dir);
  const cursor = Math.max(0, options.cursor ?? 0);
  const limit = Math.min(1000, Math.max(1, options.limit ?? 200));
  const entries: (LogEntry | ChatEntry)[] = [];
  for await (const line of journalLines(dir, cursor)) {
    const record = parseRecord(line.bytes);
    if (!record || record.ticketId !== options.ticketId) continue;
    // Read one matching record ahead to report an exact end-of-history marker.
    if (entries.length === limit) return { entries, nextCursor: line.start };
    entries.push(record.entry);
  }
  return { entries, nextCursor: null };
}
