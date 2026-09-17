"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentBusy, agentSubagents, sendToAgent, stopAgent, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { LiveSubagent } from "@/lib/types";
import ChatInput from "./ChatInput";
import { StopSquare } from "./icons";
import RequestStack from "./RequestStack";

/** Unsent text, per project, kept outside React so a remount can't eat it.
 * sessionStorage: it belongs to this tab, and nothing here needs a server. */
const DRAFT_KEY = "autoproject-board-draft:";
function readDraft(key: string) {
  try {
    return sessionStorage.getItem(DRAFT_KEY + key) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(DRAFT_KEY + key, value);
    else sessionStorage.removeItem(DRAFT_KEY + key);
  } catch {
    // Private mode or a blocked store: the draft just isn't durable.
  }
}

const NONE: LiveSubagent[] = [];

/** The subagents the chat's agent has working for it, one violet row each,
 * gone as each reports back. Nothing renders while there are none. */
function Subagents() {
  const subagents = useSyncExternalStore(subscribeRuns, agentSubagents, () => NONE);
  if (subagents.length === 0) return null;
  return (
    <div className="space-y-1.5 pb-2">
      {subagents.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-800"
        >
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
          <span className="min-w-0 flex-1 truncate" title={s.description}>
            {s.description || "Subagent"}
          </span>
          {s.type && <span className="shrink-0 text-violet-500/70">{s.type}</span>}
        </div>
      ))}
    </div>
  );
}

/** The one input bar under the view, talking to the project agent in whichever
 * mode is showing: on the board it plans tickets, over the chat it does the
 * work. It sits outside the sliding sheet, so switching modes leaves it put. */
export default function BottomBar() {
  const projectId = useStore((s) => s.projectId) ?? "";
  const mode = useStore((s) => s.mode);
  const busy = useSyncExternalStore(subscribeRuns, agentBusy, () => false);

  // The draft outlives the input: a remount — a reload, a dev-server refresh —
  // brings back what was typed.
  const [draft, setDraftState] = useState(() => readDraft(projectId));
  const setDraft = (v: string) => {
    setDraftState(v);
    writeDraft(projectId, v);
  };

  // The bar never closes: on the board a message queues behind the one being
  // worked on — the stack above the bar shows where it stands — and over the
  // chat it reaches the agent mid-turn, so the transcript shows it at once.
  const stoppable = busy && mode === "act";

  // Arrow-up recall, per mode: what was sent to the board is not what one
  // would resend to the chat. Newest last; repeats collapsed to their latest.
  const chat = useStore((s) => s.project.chat);
  const history = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m.kind !== "user" || m.mode !== mode || seen.has(m.text)) continue;
      seen.add(m.text);
      out.unshift(m.text);
    }
    return out;
  }, [chat, mode]);
  // Where in the history the box is showing (history.length = the draft
  // itself), and the typing that was there before recalling, to come back to.
  const recall = useRef<{ at: number; stash: string } | null>(null);
  function walkHistory(dir: "back" | "forward") {
    const cur = recall.current ?? { at: history.length, stash: draft };
    const at = Math.max(0, Math.min(history.length, cur.at + (dir === "back" ? -1 : 1)));
    if (at === cur.at) return;
    recall.current = at === history.length ? null : { ...cur, at };
    setDraft(at === history.length ? cur.stash : history[at]);
  }
  const edit = (v: string) => {
    recall.current = null; // typing makes it the person's own text again
    setDraft(v);
  };

  async function send() {
    const text = draft.trim();
    if (!text) return;
    recall.current = null;
    setDraft("");
    // Never reached the server: the words are still the person's to send again.
    if (!(await sendToAgent(mode, text))) setDraft(text);
  }

  /** Words handed back by a dropped request go into the box, after any typing. */
  const takeBack = (text: string) =>
    setDraft(draft.trim() ? `${draft.trim()} ${text}` : text);

  return (
    <div className="shrink-0" style={{ margin: "0 5px 5px" }}>
      {/* The chat sheet has its own transcript; the stack is the board's. */}
      {mode === "panel" && <RequestStack onDropped={takeBack} />}
      {mode === "act" && <Subagents />}
      <div className="flex items-center gap-2">
        <ChatInput
          value={draft}
          onChange={edit}
          onSend={send}
          onHistory={walkHistory}
          placeholder={
            mode === "act"
              ? "What should be done?"
              : "What should be changed? AI will turn it into tickets and get to work"
          }
          sendTitle={mode === "act" ? "Send" : "Send — AI will turn it into tickets"}
        />
        {/* Stopping a board request is its row's ✕; the bar's square is the chat's. */}
        {stoppable && <StopSquare onClick={stopAgent} title="Stop the agent" />}
      </div>
    </div>
  );
}
