"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ActSheet from "@/components/ActSheet";
import BoardView from "@/components/BoardView";
import BottomBar from "@/components/BottomBar";
import Toolbar from "@/components/Toolbar";
import { useSwipeNav } from "@/components/useSwipeNav";
import { useStore } from "@/lib/store";
import { openProject, startAutosave } from "@/lib/sync";

const ProjectPicker = dynamic(() => import("@/components/ProjectPicker"), { ssr: false });

const emptySubscribe = () => () => {};

export default function Home() {
  // The store persists to localStorage; render only on the client to avoid
  // hydrating server HTML built from the default (empty) project.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const projectId = useStore((s) => s.projectId);
  const projectLoaded = useStore((s) => s.projectLoaded);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mode = useStore((s) => s.mode);
  const mainRef = useRef<HTMLElement>(null);
  useSwipeNav(mainRef);

  useEffect(() => {
    startAutosave();
  }, []);

  // Re-fetch the persisted project on load (localStorage only keeps the id).
  useEffect(() => {
    if (mounted && projectId && !projectLoaded) void openProject(projectId).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load project"));
  }, [mounted, projectId, projectLoaded]);

  // Ctrl+M flips between the board and the chat. Ctrl only: Cmd+M minimizes
  // the window on macOS, and the input bar must not eat either as a letter.
  useEffect(() => {
    if (!projectId || !projectLoaded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        useStore.getState().toggleMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, projectLoaded]);

  if (!mounted) return <div className="h-screen bg-zinc-50" />;

  if (!projectId || !projectLoaded) {
    return (
      <div className="h-screen flex flex-col bg-zinc-50 text-zinc-900">
        {projectId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
            {loadError ? <div role="alert">{loadError}<button className="ml-3 underline" onClick={() => { setLoadError(null); useStore.getState().closeProject(); }}>Back to projects</button></div> : "Loading project…"}
          </div>
        ) : (
          <ProjectPicker />
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-50 text-zinc-900">
      <Toolbar />
      <main ref={mainRef} className="flex-1 relative min-w-0">
        {/* One frame holds the view: the board, the chat sheet that rides up
            over it, and the input bar under both — the bar stays put whichever
            of the two is showing. The frame clips the sheet's travel. */}
        <div className="absolute overflow-hidden rounded-lg flex flex-col" style={{ inset: 3 }}>
          <div className="relative flex-1 min-h-0 overflow-hidden">
            <BoardView />
            <ActSheet open={mode === "act"} />
          </div>
          <BottomBar />
        </div>
        {/* The outline is chrome, drawn over the view so nothing inside it can
            paint over the hairline. */}
        <div
          aria-hidden
          className="pointer-events-none absolute z-30 rounded-lg border border-zinc-400"
          style={{ inset: 3 }}
        />
      </main>
    </div>
  );
}
