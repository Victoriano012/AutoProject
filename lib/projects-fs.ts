import fs from "fs";
import os from "os";
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
const REGISTRY = path.join(os.homedir(), ".autoproject", "imports.json");

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
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify([...new Set(paths)], null, 2));
}

export function readProject(dir: string): Project | null {
  try {
    return migrate(JSON.parse(fs.readFileSync(projectFile(dir), "utf8")));
  } catch {
    return null;
  }
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
  return { ...rest, notes: rest.notes ?? [], tickets, workers: rest.workers ?? [], chat };
}

export function writeProject(dir: string, project: Project) {
  fs.mkdirSync(path.join(dir, ".autoproject"), { recursive: true });
  fs.writeFileSync(projectFile(dir), JSON.stringify(project, null, 2));
}

function row(dir: string): ProjectRow | null {
  const p = readProject(dir);
  if (!p) return null;
  return {
    id: dir,
    name: p.name,
    updated_at: fs.statSync(projectFile(dir)).mtime.toISOString(),
    metaPosition: p.metaPosition,
    // Asked of the board's own column function so the picker and the board can
    // never disagree about what is working, waiting or stuck.
    status: {
      working: p.tickets.some((t) => boardColumn(t) === "working"),
      review: p.tickets.some((t) => boardColumn(t) === "review"),
      blocked: p.tickets.some((t) => boardColumn(t) === "blocked"),
    },
  };
}

export function listProjects(): ProjectRow[] {
  const dirs = new Set<string>(readRegistry());
  if (fs.existsSync(BASE)) {
    for (const name of fs.readdirSync(BASE)) dirs.add(path.join(BASE, name));
  }
  return [...dirs]
    .filter((dir) => !readProject(dir)?.hidden)
    .map(row)
    .filter((r): r is ProjectRow => r !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createProject(name: string): ProjectRow {
  const safe = name.replace(/[/\\:]/g, "-").trim() || "untitled";
  const dir = path.join(BASE, safe);
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
export function eraseProject(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  writeRegistry(readRegistry().filter((p) => p !== dir));
}
