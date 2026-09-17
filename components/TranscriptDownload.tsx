"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { ChatEntry, LogEntry } from "@/lib/types";

/** The server's append-only history includes entries beyond the live window. */
export default function TranscriptDownload({ ticketId }: { ticketId?: string }) {
  const projectId = useStore((s) => s.projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function download() {
    if (!projectId || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const parts: string[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const params = new URLSearchParams({ cursor: String(cursor), limit: "1000" });
        if (ticketId) params.set("ticketId", ticketId);
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/history?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not download the transcript");
        const page: { entries: (LogEntry | ChatEntry)[]; nextCursor: number | null } = await response.json();
        for (const entry of page.entries) {
          parts.push(`[${new Date(entry.ts).toISOString()}] ${entry.kind}${"mode" in entry ? ` (${entry.mode})` : ""}\n${entry.text}\n\n`);
        }
        if (page.nextCursor !== null && page.nextCursor <= cursor) throw new Error("Transcript pagination did not advance");
        cursor = page.nextCursor;
      }
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob(parts, { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = ticketId ? `ticket-${ticketId}-transcript.txt` : "project-transcript.txt";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      request.current = null;
      setBusy(false);
    }
  }
  return <div className="text-[11px]" onClick={(e) => e.stopPropagation()}>
    <button disabled={busy} className="text-violet-600 disabled:text-zinc-400" onClick={() => void download()}>
      {busy ? "Downloading…" : "Download full transcript"}
    </button>
    {error && <p role="alert" className="text-red-600">{error}</p>}
  </div>;
}
