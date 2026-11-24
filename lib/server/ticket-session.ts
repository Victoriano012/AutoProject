import { type Attachment, type Ticket, type Worker } from "../types";
import { resumableSession, providerForModel } from "./model-settings";
import { selectedModel } from "../config";
import { addStats } from "../stats";
import { type RunUsage, streamAgent } from "./agent";
import * as store from "./project-store";
import { registry, ticketKey } from "./run-registry";
import { runLimiter } from "./run-limiter";
import { notifyRuns } from "./runs";
import { restartNote, suspended } from "./restart";

// ---- notes the person adds to a card in flight ----------------------------

/** Take the indications waiting for this ticket's agent. Always drains: the
 * board writes each one into the ticket itself as well, so the durable copy is
 * the ticket's description and this queue only carries the live hand-over. */
function takeNotes(key: string): string[] {
  const notes = registry.notes.get(key) ?? [];
  registry.notes.delete(key);
  return notes;
}

/** What an aborted session says in the log: the person's stop — unless it was
 * their own note interrupting the agent, which the run resumes from. */
function abortText(key: string): string {
  return registry.notes.has(key)
    ? "Taking your indication into account…"
    : "Stopped by user";
}

const ticketOf = (dir: string, id: string): Ticket | undefined =>
  store.getProject(dir)?.tickets.find((t) => t.id === id);

const workerOf = (dir: string, id: string): Worker | undefined => {
  const workerId = ticketOf(dir, id)?.workerId;
  return store.getProject(dir)?.workers.find((w) => w.id === workerId);
};

// ---- what the work cost ---------------------------------------------------

/**
 * Fold one agent session's numbers into the ticket that ran.
 *
 * A server-written ticket field, so `stats` is in `runFields` (see
 * run-state.ts) — without that the browser's next autosave would wipe every
 * total, since the browser owns the ticket otherwise.
 *
 * Only what the provider actually reported goes in: time is measured here,
 * tokens and cost come from the result message, and a run whose provider gave
 * no cost is counted in `runsWithoutCost` instead of being priced from a table.
 */
function recordRun(dir: string, ticketId: string, ms: number, usage?: RunUsage, runs = 1): void {
  store.updateTicket(dir, ticketId, (t) => ({
    ...t,
    stats: addStats(t.stats, {
      runs,
      ms,
      tokens: usage?.tokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
      runsWithoutCost: usage?.costUsd === undefined ? runs : 0,
    }),
  }));
}

// ---- one agent session ----------------------------------------------------

export interface SessionOutcome {
  ok: boolean;
  text: string;
  aborted: boolean;
  /** Set when a restart cut the session short: what to send, in which
   * conversation, to carry it on (the restart note once the agent was at
   * work, else what it was about to be sent). */
  suspended?: { prompt: string; sessionId?: string };
}

/** Each CLI's answer to resuming a conversation it no longer has: Claude Code's,
 * Codex's, and the one gemini.ts gives for agy, which silently starts anew. */
const MISSING_SESSION = /No conversation found with session ID|no rollout found for thread id|conversation "[^"]*" not found/;

/** Drop a conversation the CLI no longer has from the ticket and its worker, so
 * neither resumes it again; the new conversation's init fills them back in. */
function forgetSession(dir: string, ticketId: string, sessionId: string): void {
  store.updateTicket(dir, ticketId, (t) => (t.sessionId === sessionId ? { ...t, sessionId: undefined } : t));
  const worker = workerOf(dir, ticketId);
  if (worker?.sessionId === sessionId) store.setWorkerSession(dir, worker.id, undefined);
}

async function runAgentSession(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model?: string;
    /** What a new conversation is told if `sessionId` turns out to be gone. */
    freshPrompt?: () => string;
  }
): Promise<SessionOutcome> {
  const key = ticketKey(dir, ticketId);
  const ctrl = new AbortController();
  registry.controllers.set(key, ctrl);
  notifyRuns(dir);

  let releaseCapacity: (() => void) | undefined;
  let ok = false;
  let finalText = "";
  let usage: RunUsage | undefined;
  let started: number | undefined;
  let errorLogged = false;
  // The conversation this session reached, once the agent is at work in it.
  let live: string | undefined;

  try {
    await store.flush(dir);
    releaseCapacity = await runLimiter.acquire(providerForModel(body.model ?? selectedModel()), ctrl.signal);
    ctrl.signal.throwIfAborted();
    started = Date.now();
    let { prompt, sessionId } = body;
    for (;;) {
      let expired = false;
      const events = streamAgent({
        workspaceDir: store.getProject(dir)?.workspaceDir,
        prompt,
        sessionId,
        attachments: body.attachments?.map(({ name, dataUrl }) => ({ name, dataUrl })),
        signal: ctrl.signal,
        model: body.model,
        writeAccess: true,
      });
      for await (const ev of events) {
        if (ev.type === "init") {
          live = ev.sessionId;
          store.updateTicket(dir, ticketId, (t) => ({ ...t, sessionId: ev.sessionId }));
          // The worker's conversation is what its next ticket resumes — unless
          // this is feedback on a ticket from a conversation it has moved on from.
          const worker = workerOf(dir, ticketId);
          if (worker && (!sessionId || sessionId === worker.sessionId)) {
            store.setWorkerSession(dir, worker.id, ev.sessionId);
          }
        } else if (ev.type === "text") {
          store.appendLog(dir, ticketId, { kind: "text", text: ev.text, ts: Date.now() });
        } else if (ev.type === "tool") {
          store.appendLog(dir, ticketId, { kind: "tool", text: ev.text, ts: Date.now() });
        } else if (ev.type === "result") {
          ok = ev.ok;
          finalText = ev.text ?? "";
          usage = ev.usage;
          const worker = workerOf(dir, ticketId);
          if (usage?.contextTokens !== undefined && worker?.sessionId && worker.sessionId === ticketOf(dir, ticketId)?.sessionId) {
            store.setWorkerContext(dir, worker.id, usage.contextTokens);
          }
        } else if (ev.type === "error") {
          // A worker idle long enough has no conversation left to resume (Claude
          // Code deletes transcripts older than cleanupPeriodDays).
          if (sessionId && body.freshPrompt && MISSING_SESSION.test(ev.message) && !ctrl.signal.aborted) {
            expired = true;
            continue;
          }
          ok = false;
          finalText = ev.message;
          // An error the abort itself caused is not the run's own failure — the
          // CLI reports the interrupt as one. What actually happened (the person's
          // stop, or their note) is logged below instead.
          if (!ctrl.signal.aborted) {
            store.appendLog(dir, ticketId, { kind: "error", text: ev.message, ts: Date.now() });
            errorLogged = true;
          }
        }
      }
      if (!expired || ctrl.signal.aborted) break;
      forgetSession(dir, ticketId, sessionId!);
      store.appendLog(dir, ticketId, {
        kind: "info",
        text: "This worker's earlier conversation had expired, so a new one was started.",
        ts: Date.now(),
      });
      prompt = body.freshPrompt!();
      sessionId = undefined;
      finalText = "";
    }
    if (suspended(ctrl.signal)) {
      ok = false;
    } else if (ctrl.signal.aborted) {
      ok = false;
      finalText = "Stopped by user";
      store.appendLog(dir, ticketId, { kind: "info", text: abortText(key), ts: Date.now() });
    } else if (!ok && !errorLogged) {
      // A failed result (a usage limit, an API error) otherwise lands only in
      // resultSummary, which the card never shows: it would just turn red.
      store.appendLog(dir, ticketId, {
        kind: "error",
        text: finalText || "The agent ended without a result.",
        ts: Date.now(),
      });
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    if (!suspended(ctrl.signal)) store.appendLog(dir, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: ctrl.signal.aborted ? abortText(key) : finalText,
      ts: Date.now(),
    });
  } finally {
    releaseCapacity?.();
    registry.controllers.delete(key);
    // A stopped or failed session still spent the time and the tokens it spent;
    // one a restart cut short counts as a run once, when it is carried on.
    if (started !== undefined) recordRun(dir, ticketId, Date.now() - started, usage, suspended(ctrl.signal) ? 0 : 1);
    notifyRuns(dir);
  }
  return {
    ok,
    text: finalText,
    aborted: ctrl.signal.aborted,
    ...(suspended(ctrl.signal) && {
      suspended: live ? { prompt: restartNote(), sessionId: live } : { prompt: body.prompt, sessionId: body.sessionId },
    }),
  };
}

/**
 * The ticket's session, and any session the person's own indications ask for
 * after it. A note typed on the card interrupts the open session (see
 * `noteTicket`); this resumes that same session with what they said, so
 * everything the agent had already done stays in its context, the ticket keeps
 * its "running" status throughout — the card never leaves Working — and there
 * is never a second agent in one workspace. Normally exactly one pass. A
 * session a restart cut short ends it: the next server carries that on.
 */
export async function runWithNotes(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model: string;
    freshPrompt?: () => string;
  }
): Promise<SessionOutcome> {
  const key = ticketKey(dir, ticketId);
  for (;;) {
    const outcome = await runAgentSession(dir, ticketId, body);
    if (outcome.suspended) return outcome;
    const notes = takeNotes(key);
    if (notes.length === 0 || registry.userStopped.has(key)) return outcome;
    const resumed = resumableSession(ticketOf(dir, ticketId)?.sessionId, body.model)?.stored;
    // No session to resume (the agent never reached init): the ticket settles,
    // and the indication is still in its description for the next run.
    if (!resumed) return outcome;
    body = {
      prompt:
        `While you were working, the person added indications for this ticket:\n\n` +
        notes.join("\n\n") +
        `\n\nTake them into account and carry on with the ticket, then finish as instructed above.`,
      sessionId: resumed,
      model: body.model,
    };
  }
}
