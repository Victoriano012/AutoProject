"use client";

import { useState, useSyncExternalStore } from "react";
import {
  agentBusy,
  isProjectRunning,
  runProject,
  stopAgent,
  stopProject,
  subscribeRuns,
} from "@/lib/runner";
import { useStore } from "@/lib/store";
import GearIcon from "./GearIcon";
import { BoardIcon, ChatIcon, PlayIcon, Spinner, StopIcon } from "./icons";
import Logo from "./Logo";
import SettingsModal from "./SettingsModal";

export default function Toolbar() {
  const project = useStore((s) => s.project);
  const closeProject = useStore((s) => s.closeProject);
  const setProject = useStore((s) => s.setProject);
  const mode = useStore((s) => s.mode);
  const toggleMode = useStore((s) => s.toggleMode);

  const [showSettings, setShowSettings] = useState(false);

  // Pushed by the runner the moment the run starts or settles — a poll would
  // both lag and keep saying "running" for a run with nothing left to do.
  const runGoing = useSyncExternalStore(subscribeRuns, isProjectRunning, () => false);
  // The project agent mid-turn is the project working too, and this corner is
  // where a person looks to see whether anything is — so it shows both, and its
  // stop halts whatever is going.
  const agentGoing = useSyncExternalStore(subscribeRuns, agentBusy, () => false);
  const running = runGoing || agentGoing;

  return (
    <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-white border-b border-zinc-200">
      {/* The mark is the way back, at the size the projects view draws it. */}
      <button className="shrink-0" onClick={closeProject} title="Back to your projects">
        <Logo size={26} className="text-zinc-900" />
      </button>
      <input
        className="bg-transparent text-2xl font-semibold outline-none rounded px-1 focus:bg-zinc-100 flex-1 min-w-40"
        value={project.name}
        onChange={(e) => setProject({ name: e.target.value })}
        aria-label="Project name"
      />

      <div className="ml-auto shrink-0 flex items-center gap-3">
        {/* Slot kept at icon size whether or not it holds the spinner, so the
            row doesn't shift when a run starts. */}
        <span className="h-5 w-5" title={running ? "Run in progress" : undefined}>
          {running && <Spinner className="h-5 w-5" />}
        </span>
        {running ? (
          <button
            className="rounded-lg px-2 py-1.5 text-red-600 hover:bg-zinc-200 hover:text-red-500"
            onClick={() => {
              if (runGoing) stopProject();
              if (agentGoing) stopAgent();
            }}
            title={runGoing ? "Stop the run" : "Stop the agent"}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="rounded-lg px-2 py-1.5 text-emerald-600 hover:bg-zinc-200 hover:text-emerald-500 disabled:opacity-50"
            onClick={() => void runProject()}
            disabled={project.tickets.length === 0}
            title="Run the project"
          >
            <PlayIcon />
          </button>
        )}
        {/* Shows the view you would switch to, not the one you are in. */}
        <button
          className="rounded-lg px-2 py-1.5 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={toggleMode}
          title="Switch view (Ctrl+M)"
          aria-pressed={mode === "act"}
        >
          {mode === "act" ? <BoardIcon /> : <ChatIcon />}
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </header>
  );
}
