"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  MODEL_CHOICES,
  withSelectedModel,
  type ModelChoice,
  REASONING_LABELS,
  reasoningEffortsForModel,
  resolveReasoningEffort,
  type ModelProvider,
  type ReasoningEffort,
} from "@/lib/models";
import AttachmentEditor from "./AttachmentEditor";
import StatsModal from "./StatsModal";

type CatalogResponse = {
  models: ModelChoice[];
  providers: Record<ModelProvider, { source: string; error?: string; lastSuccessAt?: number }>;
};

async function fetchCatalog(force: boolean, signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch("/api/models", { method: force ? "POST" : "GET", cache: "no-store", signal });
  if (!response.ok) throw new Error("Could not refresh models. Keeping the current catalog.");
  return response.json();
}

const PROVIDERS: { value: ModelProvider; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

/** App-wide settings, plus the open project's own fields. Add future settings
 * as more labeled rows below. */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // Per-project settings; absent when settings opens from the meta-graph.
  const projectId = useStore((s) => s.projectId);
  const description = useStore((s) => s.project.description);
  const workspaceDir = useStore((s) => s.project.workspaceDir);
  const attachments = useStore((s) => s.project.attachments);
  const notes = useStore((s) => s.project.notes);
  const setProject = useStore((s) => s.setProject);

  const [model, setModel] = useState(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showStats, setShowStats] = useState(false);
  const [catalog, setCatalog] = useState<readonly ModelChoice[]>(MODEL_CHOICES);
  const [refreshing, setRefreshing] = useState(true);
  const [catalogMessage, setCatalogMessage] = useState("");
  const choices = withSelectedModel(catalog, model);
  const reasoningLevels = reasoningEffortsForModel(model, choices);
  const effectiveEffort = resolveReasoningEffort(model, reasoningEffort, choices);
  const usesCliDefault = resolveReasoningEffort(model, undefined, choices) === undefined;
  const reasoningMin = reasoningLevels.length > 0 && usesCliDefault ? -1 : 0;

  function catalogStatus(result: CatalogResponse) {
    const unavailable = PROVIDERS.filter((p) => result.providers[p.value]?.error).map((p) => p.label);
    return unavailable.length
      ? `${unavailable.join(", ")}: using saved models or bundled defaults.`
      : "Models are up to date. Automatic checks are cached for five minutes.";
  }

  async function refreshModels() {
    setRefreshing(true);
    try {
      const result = await fetchCatalog(true);
      setCatalog((previous) => withSelectedModel(result.models, model, previous));
      setCatalogMessage(catalogStatus(result));
    } catch (err) {
      setCatalogMessage(err instanceof Error ? err.message : "Could not refresh models.");
    } finally { setRefreshing(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/config", { signal: controller.signal, cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load settings. Close and try again.");
        return res.json();
      })
      .then((cfg: { model?: string; reasoningEffort?: ReasoningEffort; savedReasoningEffort?: ReasoningEffort }) => {
        const savedModel = cfg.model || DEFAULT_MODEL;
        if (controller.signal.aborted) return;
        setModel(savedModel);
        setReasoningEffort(cfg.savedReasoningEffort ?? cfg.reasoningEffort ?? DEFAULT_REASONING_EFFORT);
        setLoaded(true);
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load settings."); });
    void fetchCatalog(false, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalog(result.models);
        setCatalogMessage(catalogStatus(result));
      })
      .catch(() => { if (!controller.signal.aborted) setCatalogMessage("Could not refresh models. Using bundled defaults."); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    // Escape belongs to whichever view is on top: the stats view closes back to
    // settings, not straight out of both.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showStats) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showStats]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, reasoningEffort: effectiveEffort }),
      });
      if (!res.ok) throw new Error("Could not save settings. Please try again.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  // The stats view takes over the whole overlay rather than stacking on it, so
  // one backdrop click or Escape means one thing. Settings keeps its state.
  if (showStats) return <StatsModal onClose={() => setShowStats(false)} />;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Model</span>
            <select
              className="mt-1 w-full rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
              value={model}
              disabled={!loaded || busy || refreshing}
              onChange={(e) => {
                const nextModel = e.target.value;
                setModel(nextModel);
                setReasoningEffort(resolveReasoningEffort(nextModel, reasoningEffort, choices) ?? DEFAULT_REASONING_EFFORT);
              }}
            >
              {PROVIDERS.map((provider) => (
                <optgroup key={provider.value} label={provider.label}>
                  {choices.filter(
                    (modelChoice) => modelChoice.provider === provider.value
                  ).map((modelChoice) => (
                    <option key={modelChoice.value} value={modelChoice.value}>
                      {modelChoice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div>
            <button type="button" disabled={refreshing || busy} onClick={() => void refreshModels()}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50">
              {refreshing ? "Refreshing models…" : "Refresh models"}
            </button>
            <p role="status" className="mt-2 text-xs text-zinc-500">{catalogMessage}</p>
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="reasoning-level" className="text-sm font-medium text-zinc-700">
                Reasoning level
              </label>
              <span className="text-sm font-medium text-violet-600">
                {effectiveEffort ? REASONING_LABELS[effectiveEffort] : "CLI default"}
              </span>
            </div>
            <input
              id="reasoning-level"
              type="range"
              min={reasoningMin}
              max={Math.max(reasoningMin + 1, reasoningLevels.length - 1)}
              step={1}
              value={effectiveEffort ? reasoningLevels.indexOf(effectiveEffort) : reasoningMin}
              disabled={!loaded || busy || refreshing || reasoningLevels.length === 0 || (reasoningLevels.length === 1 && !usesCliDefault)}
              aria-valuetext={effectiveEffort ? REASONING_LABELS[effectiveEffort] : "CLI default"}
              aria-describedby="reasoning-description"
              onChange={(e) => setReasoningEffort(reasoningLevels[Number(e.target.value)] ?? DEFAULT_REASONING_EFFORT)}
              className="mt-3 block h-2 w-full cursor-pointer accent-violet-600 disabled:cursor-not-allowed disabled:opacity-40"
            />
            {reasoningLevels.length > 0 && (
              <div className="mt-2 flex justify-between text-[10px] text-zinc-500" aria-hidden="true">
                {usesCliDefault && <span>CLI default</span>}
                {reasoningLevels.map((level) => <span key={level}>{REASONING_LABELS[level]}</span>)}
              </div>
            )}
            <p id="reasoning-description" className="mt-2 text-xs text-zinc-500">
              {!effectiveEffort
                ? "No verified reasoning setting is selected; the agent tool uses its default."
                : effectiveEffort === "ultra"
                  ? "Maximum reasoning with automatic task delegation."
                  : "Higher levels spend more time reasoning. Uses High when supported, otherwise the reported default."}
            </p>
          </div>
          {/* The project's own fields autosave like everything else the person
            * types (browser-owned, see lib/run-state.ts); Save below is for the
            * app-wide settings only. */}
          {projectId && (
            <label className="block">
              <span className="text-sm font-medium text-zinc-700">
                Project description
              </span>
              <textarea
                className="mt-1 w-full min-h-28 rounded-lg bg-zinc-50 border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
                placeholder="Describe what this project should accomplish…"
                value={description}
                onChange={(e) => setProject({ description: e.target.value })}
              />
            </label>
          )}
          {projectId && (
            <label className="block">
              <span className="text-sm font-medium text-zinc-700">
                Workspace directory
              </span>
              <input
                className="mt-1 w-full rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
                placeholder="Server path where the agents work (empty = temp)"
                value={workspaceDir}
                onChange={(e) => setProject({ workspaceDir: e.target.value })}
                title="Directory on the server where the agents work"
              />
            </label>
          )}
          {projectId && (
            <AttachmentEditor
              label="Context files"
              attachments={attachments ?? []}
              onChange={(next) => setProject({ attachments: next })}
            />
          )}
          {projectId && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-700">
                  Standing instructions
                </span>
                <button
                  className="cursor-pointer inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white hover:border-violet-400 hover:text-violet-600 px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm transition-colors"
                  title="Something every ticket's agent must know"
                  onClick={() => setProject({ notes: [...notes, ""] })}
                >
                  <span className="text-sm leading-none">＋</span> Add
                </button>
              </div>
              {notes.map((note, i) => (
                <div key={i} className="mt-1 flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1 text-sm outline-none focus:border-zinc-500"
                    placeholder="Always use pnpm"
                    value={note}
                    onChange={(e) =>
                      setProject({
                        notes: notes.map((n, j) => (j === i ? e.target.value : n)),
                      })
                    }
                  />
                  <button
                    className="shrink-0 text-xs text-zinc-400 hover:text-red-500"
                    title="Remove"
                    onClick={() => setProject({ notes: notes.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {projectId && (
            <div>
              <span className="text-sm font-medium text-zinc-700">Stats</span>
              <button
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => setShowStats(true)}
                title="Tickets, time, cost and rejections for this project"
              >
                See project stats…
              </button>
            </div>
          )}
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex items-center gap-2">
          <button
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={!loaded || busy || refreshing}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
