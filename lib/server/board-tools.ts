import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { addTicketsSchema, notesSchema, requestJsonSchema } from "../board-schema";
export { parsePlannedTickets } from "../board-schema";
import type { Ticket } from "../types";
import * as store from "./project-store";
import { autoRun } from "./runs";

/**
 * The board as the project agent sees it in panel mode: two in-process MCP
 * tools. Tickets written this way land on the board mid-turn (the handler
 * writes straight into the store), which is why panel mode does not use the
 * SDK's structured output — that would only arrive when the turn ends.
 */

export const ADD_TICKETS_SHAPE = addTicketsSchema.shape;
export const REQUEST_SCHEMA = requestJsonSchema;

/** Put the planner's tickets on the board, start them, and say so in the chat. */
export function addTicketsToBoard(dir: string, tickets: store.PlannedTicket[]): Ticket[] {
  const added = store.addTickets(dir, tickets);
  if (added.length === 0) return added;
  autoRun(dir);
  store.appendChat(dir, [
    {
      kind: "info",
      text: `Added ${added.length} ticket(s): ${added.map((t) => t.title).join("; ")}`,
      ts: Date.now(),
      mode: "panel",
      ticketIds: added.map((t) => t.id),
    },
  ]);
  return added;
}

/** Tool names as the model sees them: mcp__board__add_tickets, mcp__board__set_notes. */
export function boardServer(dir: string) {
  return createSdkMcpServer({
    name: "board",
    version: "1",
    tools: [
      tool(
        "add_tickets",
        "Put tickets on the board for the coding agents. Call at most once per request; pass an empty array when the request needs no work.",
        ADD_TICKETS_SHAPE,
        async ({ tickets }) => {
          const added = addTicketsToBoard(dir, tickets);
          await store.flush(dir);
          return {
            content: [
              {
                type: "text",
                text: `Added ${added.length} ticket(s): ${added.map((t) => t.title).join("; ")}`,
              },
            ],
          };
        }
      ),
      tool(
        "set_notes",
        "Replace the project's standing instructions (short imperative sentences).",
        notesSchema.shape,
        async ({ notes }) => {
          store.setNotes(dir, notes);
          await store.flush(dir);
          return { content: [{ type: "text", text: "Notes saved." }] };
        }
      ),
    ],
  });
}
