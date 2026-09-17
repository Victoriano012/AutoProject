import fs from "fs";
import os from "os";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hydrateAttachments, prepareAttachments, writeAssets, writeAssetsSync } from "./server/project-attachments";
import path from "path";
import {
  boardColumn,
  type ChatEntry,
  defaultProject,
  type Project,
  type Ticket,
  type Worker,
} from "./types";

/** New projects are created as subfolders of this directory. */
const BASE = process.env.AUTOPROJECT_HOME || path.join(os.homedir(), "Documents", "personal");
/** Remembers workspaces imported from outside BASE. */
const REGISTRY = process.env.AUTOPROJECT_REGISTRY || path.join(os.homedir(), ".autoproject", "imports.json");

export interface ProjectRow {
  id: string; // absolute workspace path
  name: string;
  updated_at: string;
  metaPosition?: { x: number; y: number };
  /** Which board columns have cards in them, so the meta-graph can colour a
   * project by what is going on inside it. Done is left out: a finished card
   * is not something the picker needs to say anything about. */
  status: ProjectStatus;
}

export interface ProjectStatus {
  working: boolean;
  review: boolean;
  blocked: boolean;
}

const projectFile = (dir: string) => path.join(dir, ".autoproject", "project.json");

function readRegistry(): string[] {
  try {
    // The registry lives in the user's runtime data directory.
    const paths: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ REGISTRY, "utf8"));
    return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  const temporary = `${REGISTRY}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify([...new Set(paths)], null, 2), { mode: 0o600 });
    fs.renameSync(temporary, REGISTRY);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readProject(dir: string): Project | null {
  try {
    return hydrateAttachments(dir, readProjectMetadata(dir));
  } catch {
    return null;
  }
}

function readProjectMetadata(dir: string): Project {
  return migrate(JSON.parse(fs.readFileSync(projectFile(dir), "utf8")));
}

/** The graph era's file shape: nested tickets under `graph`, a role/text chat. */
interface LegacyGraph {
  tickets: (Ticket & { subgraph?: LegacyGraph })[];
}
type LegacyProject = Omit<Project, "notes" | "chat" | "tickets" | "workers"> & {
  graph?: LegacyGraph;
  chatSessionId?: string;
  notes?: string[];
  tickets?: Ticket[];
  workers?: Worker[];
  chat?: (ChatEntry | { role: "user" | "agent"; text: string })[];
};

/** Bring an older project.json up to the flat shape. Every leaf of the old
 * graph becomes a card, keeping only a card's fields; the containers that held
 * them were only structure. */
function migrate(raw: LegacyProject): Project {
  const rest = { ...raw };
  delete rest.graph;
  delete rest.chatSessionId;
  const tickets: Ticket[] = rest.tickets ?? [];
  const hoist = (g: LegacyGraph | undefined) => {
    for (const t of g?.tickets ?? []) {
      if (t.subgraph?.tickets.length) hoist(t.subgraph);
      else
        tickets.push({
          id: t.id,
          title: t.title,
          description: t.description,
          files: t.files,
          attachments: t.attachments,
          paused: t.paused,
          status: t.status,
          statusChangedAt: t.statusChangedAt,
          sessionId: t.sessionId,
          log: t.log,
          resultSummary: t.resultSummary,
          stats: t.stats,
        });
    }
  };
  hoist(raw.graph);
  const chat: ChatEntry[] = (rest.chat ?? []).map((m) =>
    "role" in m
      ? { kind: m.role === "user" ? "user" : "text", text: m.text, ts: 0, mode: "act" }
      : m
  );
  return { ...rest, revision: rest.revision ?? 0, notes: rest.notes ?? [], tickets, workers: rest.workers ?? [], chat };
}

/** Sync compatibility for project creation and small command-line consumers.
 * Runtime agent writes use the asynchronous equivalent below. */
export function writeProject(dir: string, project: Project) {
  const prepared = prepareAttachments(dir, project);
  writeAssetsSync(prepared.assets);
  const file = projectFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(prepared.project)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    summaryCache.delete(dir);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export async function writeProjectAsync(dir: string, project: Project): Promise<void> {
  const prepared = prepareAttachments(dir, project);
  await writeAssets(prepared.assets);
  const file = projectFile(dir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(prepared.project)); await handle.sync(); }
    finally { await handle.close(); }
    await fsp.rename(temporary, file);
    summaryCache.delete(dir);
  } finally { await fsp.rm(temporary, { force: true }); }
}

const summaryCache = new Map<string, { signature: string; row: ProjectRow | null }>();

function row(dir: string): ProjectRow | null {
  try {
    const stat = fs.statSync(projectFile(dir));
    const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = summaryCache.get(dir);
    if (cached?.signature === signature) return cached.row;
    // Metadata reads deliberately avoid loading attachment payloads.
    const p = readProjectMetadata(dir);
    const result = p.hidden ? null : {
      id: dir,
      name: p.name,
      updated_at: stat.mtime.toISOString(),
      metaPosition: p.metaPosition,
      status: {
        working: p.tickets.some((t) => boardColumn(t) === "working"),
        review: p.tickets.some((t) => boardColumn(t) === "review"),
        blocked: p.tickets.some((t) => boardColumn(t) === "blocked"),
      },
    };
    summaryCache.set(dir, { signature, row: result });
    return result;
  } catch { summaryCache.delete(dir); return null; }
}

export function listProjects(): ProjectRow[] {
  const dirs = new Set<string>(readRegistry());
  // User workspaces are discovered at runtime; never trace them into a build.
  if (fs.existsSync(/* turbopackIgnore: true */ BASE)) {
    for (const name of fs.readdirSync(/* turbopackIgnore: true */ BASE)) dirs.add(path.join(/* turbopackIgnore: true */ BASE, name));
  }
  for (const dir of summaryCache.keys()) if (!dirs.has(dir)) summaryCache.delete(dir);
  return [...dirs].map(row).filter((r): r is ProjectRow => r !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createProject(name: string): ProjectRow {
  const safe = name.replace(/[/\\:]/g, "-").trim().replace(/^\.+$/, "") || "untitled";
  const dir = path.join(/* turbopackIgnore: true */ BASE, safe);
  if (readProject(dir)) throw new Error(`"${safe}" already exists — import it instead`);
  writeProject(dir, defaultProject(name, dir));
  return row(dir)!;
}

/** Any folder works: adopts an existing .autoproject, creates one otherwise.
 * Re-importing a hidden project brings it back onto the meta-graph. */
export function importProject(rawPath: string): ProjectRow {
  const dir = path.resolve(rawPath.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  const existing = readProject(dir);
  if (!existing) {
    writeProject(dir, defaultProject(path.basename(dir), dir));
  } else if (existing.hidden) {
    writeProject(dir, { ...existing, hidden: undefined });
  }
  if (path.dirname(dir) !== BASE) writeRegistry([...readRegistry(), dir]);
  return row(dir)!;
}

/** Hides the project from the meta-graph; nothing on disk is deleted. */
export function hideProject(dir: string) {
  const p = readProject(dir);
  if (p) writeProject(dir, { ...p, hidden: true });
}

/** Permanently deletes the whole workspace folder from the computer. */
export function assertManagedProject(dir: string): string {
  const resolved = path.resolve(dir);
  const real = fs.realpathSync(resolved);
  const protectedPaths = [path.parse(real).root, os.homedir(), BASE];
  for (const protectedPath of protectedPaths) {
    // Resolve the actual user's protected locations only when erasing a project.
    const canonical = fs.existsSync(/* turbopackIgnore: true */ protectedPath)
      ? fs.realpathSync(/* turbopackIgnore: true */ protectedPath)
      : path.resolve(/* turbopackIgnore: true */ protectedPath);
    if (real === canonical || canonical.startsWith(real + path.sep)) {
      throw new Error("Refusing to erase a protected directory");
    }
  }
  if (resolved !== real) throw new Error("Refusing to erase a project through a symbolic link");
  const marker = projectFile(real);
  if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink() ||
      fs.lstatSync(path.dirname(marker)).isSymbolicLink() || !readProject(real)) {
    throw new Error("Directory is not a managed AutoProject workspace");
  }
  return real;
}

export function eraseProject(dir: string) {
  const managed = assertManagedProject(dir);
  fs.rmSync(managed, { recursive: true, force: false });
  summaryCache.delete(dir);
  writeRegistry(readRegistry().filter((p) => p !== dir));
}
