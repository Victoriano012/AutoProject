"use client";

import type { ProjectStatus } from "@/lib/projects-fs";
import { runProject as runProjectDir, stopProject as stopProjectDir } from "@/lib/runner";
import {
  createProject,
  deleteProject,
  importProject,
  openProject,
  saveMetaPosition,
} from "@/lib/sync";
import { zoomIntoProject } from "@/lib/view-zoom";
import {
  META_GRAPH_KEY,
  rememberedViewport,
  rememberViewport,
} from "@/lib/viewport-memory";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import GearIcon from "./GearIcon";
import { StopSquare } from "./icons";
import Logo from "./Logo";
import SettingsModal from "./SettingsModal";
import TrashIcon from "./TrashIcon";
import { useFitAllMinZoom } from "./useFitAllZoom";

// Runs started from a node, for as long as the page is open: the runner only
// watches the open project's run state, so the picker keeps its own note of
// whose ▶ was pressed to show it still going when the person comes back here.
const runningIds = new Set<string>();

/** ▶ on a project node: run the whole project. */
async function runProject(id: string): Promise<void> {
  runningIds.add(id);
  try {
    await runProjectDir(id);
  } finally {
    runningIds.delete(id);
  }
}

const isProjectRunning = (id: string) => runningIds.has(id);

function stopProject(id: string): void {
  stopProjectDir(id);
  runningIds.delete(id);
}

type ProjectNodeType = Node<
  { name: string; status: ProjectStatus; running: boolean; onDelete: () => void },
  "project"
>;

// Dashes stacked per blue fade on a working node's border. A handful reads as
// bands; this many reads as one soft fade at a 2px stroke.
const FADE_STEPS = 40;

function ProjectNodeInner({ id, data }: NodeProps<ProjectNodeType>) {
  // The server's word on what is working, or the ▶ pressed here a moment ago
  // that the server has not been asked about yet.
  const working = data.status.working || data.running;
  const { review, blocked } = data.status;
  // Live work first, then work waiting on the person, then the odd board where
  // cards are stuck with nothing moving them. Published on the node for the
  // same reason as on a ticket: the flight box wants this colour, not the hover
  // one it would read off the node you necessarily hovered to click — and a
  // single colour, so the turning look (below) goes as its blue.
  const statusBorder = working
    ? "border-transparent"
    : review
      ? "border-yellow-400"
      : blocked
        ? "border-red-300"
        : "border-zinc-300";
  const base = statusBorder === "border-zinc-300";
  return (
    <div
      data-zoom-border={working ? "border-blue-400" : statusBorder}
      className={`group relative w-64 rounded-xl border-2 bg-white p-3 pt-1.5 shadow-lg shadow-zinc-900/10 ${statusBorder}${
        base ? " hover:border-violet-400" : ""
      }`}
    >
      {/* Working: the border turns like the spinner beside the name. Blue and
          yellow dashes chase each other when review is pending too; plain
          working is six blue fades, built as ever narrower, darker dashes
          stacked on a pale track (the arrays centre each dash on the same
          spot). Strokes rather than a gradient so a segment keeps its length
          along the short side, the long side and round the corners. The svg
          spans the padding box, so the rects reach out a pixel to sit on the
          (transparent) border ring. */}
      {working && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <rect className="project-turn-track" stroke={review ? "#facc15" : "#bfdbfe"} />
          {review ? (
            <rect className="project-turn-track project-turn-dash" stroke="#60a5fa" pathLength={100} />
          ) : (
            Array.from({ length: FADE_STEPS }, (_, i) => i + 1).map((k) => {
              const period = 100 / 6;
              // Half of each period stays solid blue, the primary colour; the
              // other half dips to pale and back on a cosine, whose colour
              // barely changes at either end, so no step there is wide enough
              // to show as a tick.
              const dash = period - (period / 2) * (Math.acos(1 - (2 * k) / FADE_STEPS) / Math.PI);
              return (
                <rect
                  key={k}
                  className="project-turn-track project-turn-dash"
                  pathLength={100}
                  style={{
                    stroke: `color-mix(in srgb, #60a5fa ${(k * 100) / FADE_STEPS}%, #bfdbfe)`,
                    strokeDasharray: `${dash / 2} ${period - dash} ${dash / 2} 0`,
                  }}
                />
              );
            })
          )}
        </svg>
      )}
      {/* One row: name, then trash, then run/stop rightmost — a project is
          just the outermost ticket, so it gets a ticket node's control row. */}
      <div className="flex items-center gap-1.5">
        <div
          className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900"
          title={data.name}
        >
          {data.name}
        </div>
        <button
          className="text-[#d64545] hover:text-red-700"
          title="Remove project (hide from this view, or erase from the computer)"
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete();
          }}
        >
          <TrashIcon />
        </button>
        {working ? (
          <span className="flex items-center gap-1.5">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border border-blue-400 border-t-transparent" />
            <StopSquare
              onClick={(e) => {
                e.stopPropagation();
                stopProject(id);
              }}
            />
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void runProject(id);
            }}
            title="Run the whole project"
            className="text-sm leading-none text-emerald-600 hover:text-emerald-500"
          >
            ▶
          </button>
        )}
      </div>
      {/* dir=rtl puts the ellipsis on the left, keeping the end of the path
          visible; <bdi> keeps the LTR path itself from reordering */}
      <div dir="rtl" className="mt-2 truncate font-mono text-[10px] text-zinc-400" title={id}>
        <bdi>{id}</bdi>
      </div>
    </div>
  );
}

const ProjectNode = memo(ProjectNodeInner);
const nodeTypes: NodeTypes = { project: ProjectNode };

/** React Flow's own default fit padding, spelled out because the zoom floor is
 * derived from the same number (see `useFitAllZoom`). */
const FIT_PADDING = 0.1;

function ProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [importPath, setImportPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function browse() {
    if (picking) return;
    setPicking(true);
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const data = await res.json();
      if (data.path) setImportPath(data.path);
    } finally {
      setPicking(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn(); // on success the project opens and this view unmounts
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New project</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Create one by name, or import an existing folder.
        </p>
        <div className="mt-4 flex gap-2">
          <input
            autoFocus
            className="flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) void run(() => createProject(name.trim()));
            }}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={!name.trim() || busy}
            onClick={() => void run(() => createProject(name.trim()))}
          >
            Create
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
            placeholder="Import folder (e.g. ~/Documents/personal/my-repo)"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && importPath.trim())
                void run(() => importProject(importPath.trim()));
            }}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300 disabled:opacity-50"
            disabled={picking}
            title="Pick a folder with Finder"
            onClick={() => void browse()}
          >
            {picking ? "Choosing…" : "Browse…"}
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300 disabled:opacity-50"
            disabled={!importPath.trim() || busy}
            onClick={() => void run(() => importProject(importPath.trim()))}
          >
            Import
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function DeleteModal({
  id,
  name,
  onClose,
  onDone,
}: {
  id: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmErase) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmErase]);

  async function del(mode: "hide" | "erase") {
    if (busy) return;
    setBusy(true);
    await deleteProject(id, mode);
    onDone();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Remove “{name}”?</h2>
        <div className="mt-4 flex items-center gap-2">
          <button
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirmErase(true)}
          >
            Delete from computer
          </button>
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void del("hide")}
          >
            Delete
          </button>
        </div>
      </div>
      {confirmErase && (
        <ConfirmDialog
          title="Erase from computer?"
          message={`The folder\n${id}\nand everything inside it will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => void del("erase")}
          onCancel={() => setConfirmErase(false)}
        />
      )}
    </div>
  );
}

export default function ProjectPicker() {
  const [nodes, setNodes] = useState<ProjectNodeType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null
  );

  // Where the meta-graph was left, for as long as the page is open: opening a
  // project unmounts this whole view, and coming back should land where it was
  // (see `lib/viewport-memory.ts`). Read at mount only, since `onMoveEnd` keeps
  // rewriting it while the graph is up.
  const [start] = useState(() => rememberedViewport(META_GRAPH_KEY));

  // Someone with a lot of projects has the same problem as a big graph of
  // tickets: the zoom-out has to go far enough to show all of them (see
  // `useFitAllZoom`). Null until the canvas has been measured, which is one
  // more reason not to render it yet.
  const areaRef = useRef<HTMLDivElement>(null);
  const minZoom = useFitAllMinZoom(nodes, areaRef, FIT_PADDING);

  // Nodes are rebuilt from the rows, but a node already on the canvas keeps its
  // object (position, selection, a drag in progress) and only takes the new
  // name and status, since this also runs on a timer while the graph is up.
  const refresh = useCallback(async () => {
    const res = await fetch("/api/projects");
    if (!res.ok) return;
    const rows: {
      id: string;
      name: string;
      status: ProjectStatus;
      metaPosition?: { x: number; y: number };
    }[] = (await res.json()).projects;
    setNodes((nds) =>
      rows.map((r, i) => {
        const prev = nds.find((n) => n.id === r.id);
        if (!prev)
          return {
            id: r.id,
            type: "project" as const,
            position: r.metaPosition ?? { x: (i % 3) * 300, y: Math.floor(i / 3) * 140 },
            data: {
              name: r.name,
              status: r.status,
              running: isProjectRunning(r.id),
              onDelete: () => setPendingDelete({ id: r.id, name: r.name }),
            },
          };
        const d = prev.data;
        const same =
          d.name === r.name &&
          d.status.working === r.status.working &&
          d.status.review === r.status.review &&
          d.status.blocked === r.status.blocked;
        return same ? prev : { ...prev, data: { ...d, name: r.name, status: r.status } };
      })
    );
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Status changes while the picker is open — a ticket finishing, the agent
  // answering — happen on the server, so ask it again every so often.
  useEffect(() => {
    const iv = setInterval(() => void refresh(), 2000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Reflect an ongoing run (started from a node, still active after coming
  // back to the picker) on its project node.
  useEffect(() => {
    const iv = setInterval(() => {
      setNodes((nds) => {
        let changed = false;
        const next = nds.map((n) => {
          const running = isProjectRunning(n.id);
          if (running === n.data.running) return n;
          changed = true;
          return { ...n, data: { ...n.data, running } };
        });
        return changed ? next : nds;
      });
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<ProjectNodeType>[]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-white border-b border-zinc-200">
        <Logo size={26} className="shrink-0 text-zinc-900" />
        <span className="text-2xl font-semibold">Projects</span>
        <button
          className="ml-auto rounded-lg px-4 py-1.5 text-base leading-tight bg-violet-600 hover:bg-violet-500 text-white"
          onClick={() => setShowModal(true)}
        >
          + Project
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </header>
      <div ref={areaRef} className="relative flex-1 min-h-0">
        {loaded && minZoom !== null ? (
          <ReactFlow
            nodes={nodes}
            nodeTypes={nodeTypes}
            colorMode="light"
            fitView={!start}
            fitViewOptions={{ padding: FIT_PADDING, maxZoom: 1 }}
            defaultViewport={start}
            minZoom={minZoom}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            onMoveEnd={(_, viewport) => rememberViewport(META_GRAPH_KEY, viewport)}
            onNodesChange={onNodesChange}
            onNodeDragStop={(_, node) => void saveMetaPosition(node.id, node.position)}
            // A project is the outermost ticket, so opening one moves like
            // opening any other: its node grows into the whole view while the
            // fetch runs behind it.
            onNodeDoubleClick={(_, node) =>
              void openProject(node.id, zoomIntoProject(node.id))
            }
          >
            <Background variant={BackgroundVariant.Dots} gap={24} color="#d4d4d8" />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading…
          </div>
        )}
        {loaded && nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
            No projects yet — click “+ Project” to create or import one
          </div>
        )}
      </div>
      {showModal && <ProjectModal onClose={() => setShowModal(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {pendingDelete && (
        <DeleteModal
          id={pendingDelete.id}
          name={pendingDelete.name}
          onClose={() => setPendingDelete(null)}
          onDone={() => {
            setNodes((nds) => nds.filter((n) => n.id !== pendingDelete.id));
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
