import { type Attachment, type Ticket } from "../types";
import { resumableSession } from "../agent-session";
import { selectedModel } from "../config";
import { addStats } from "../stats";
import { providerForModel } from "../models";
import { type RunUsage, streamAgent } from "./agent";
import * as store from "./project-store";
import { registry, ticketKey } from "./run-registry";
import { runLimiter } from "./run-limiter";
import { notifyRuns } from "./runs";

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
function recordRun(dir: string, ticketId: string, ms: number, usage?: RunUsage): void {
  store.updateTicket(dir, ticketId, (t) => ({
    ...t,
    stats: addStats(t.stats, {
      runs: 1,
      ms,
      tokens: usage?.tokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
      runsWithoutCost: usage?.costUsd === undefined ? 1 : 0,
    }),
  }));
}

// ---- one agent session ----------------------------------------------------

async function runAgentSession(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model?: string;
  }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketKey(dir, ticketId);
  const ctrl = new AbortController();
  registry.controllers.set(key, ctrl);
  notifyRuns(dir);

  let releaseCapacity: (() => void) | undefined;
  let ok = false;
  let finalText = "";
  let usage: RunUsage | undefined;
  let started: number | undefined;

  try {
    await store.flush(dir);
    releaseCapacity = await runLimiter.acquire(providerForModel(body.model ?? selectedModel()), ctrl.signal);
    ctrl.signal.throwIfAborted();
    started = Date.now();
    const events = streamAgent({
      workspaceDir: store.getProject(dir)?.workspaceDir,
      prompt: body.prompt,
      sessionId: body.sessionId,
      attachments: body.attachments?.map(({ name, dataUrl }) => ({ name, dataUrl })),
      signal: ctrl.signal,
      model: body.model,
      writeAccess: true,
    });
    for await (const ev of events) {
      if (ev.type === "init") {
        store.updateTicket(dir, ticketId, (t) => ({ ...t, sessionId: ev.sessionId }));
        // The worker's conversation is what its next ticket resumes.
        const workerId = ticketOf(dir, ticketId)?.workerId;
        if (workerId) store.setWorkerSession(dir, workerId, ev.sessionId);
      } else if (ev.type === "text") {
        store.appendLog(dir, ticketId, { kind: "text", text: ev.text, ts: Date.now() });
      } else if (ev.type === "tool") {
        store.appendLog(dir, ticketId, { kind: "tool", text: ev.text, ts: Date.now() });
      } else if (ev.type === "result") {
        ok = ev.ok;
        finalText = ev.text ?? "";
        usage = ev.usage;
      } else if (ev.type === "error") {
        ok = false;
        finalText = ev.message;
        // An error the abort itself caused is not the run's own failure — the
        // CLI reports the interrupt as one. What actually happened (the person's
        // stop, or their note) is logged below instead.
        if (!ctrl.signal.aborted) {
          store.appendLog(dir, ticketId, { kind: "error", text: ev.message, ts: Date.now() });
        }
      }
    }
    if (ctrl.signal.aborted) {
      ok = false;
      finalText = "Stopped by user";
      store.appendLog(dir, ticketId, { kind: "info", text: abortText(key), ts: Date.now() });
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    store.appendLog(dir, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: ctrl.signal.aborted ? abortText(key) : finalText,
      ts: Date.now(),
    });
  } finally {
    releaseCapacity?.();
    registry.controllers.delete(key);
    // A stopped or failed session still spent the time and the tokens it spent.
    if (started !== undefined) recordRun(dir, ticketId, Date.now() - started, usage);
    notifyRuns(dir);
  }
  return { ok, text: finalText, aborted: ctrl.signal.aborted };
}

/**
 * The ticket's session, and any session the person's own indications ask for
 * after it. A note typed on the card interrupts the open session (see
 * `noteTicket`); this resumes that same session with what they said, so
 * everything the agent had already done stays in its context, the ticket keeps
 * its "running" status throughout — the card never leaves Working — and there
 * is never a second agent in one workspace. Normally exactly one pass.
 */
export async function runWithNotes(
  dir: string,
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model: string;
  }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketKey(dir, ticketId);
  for (;;) {
    const outcome = await runAgentSession(dir, ticketId, body);
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
