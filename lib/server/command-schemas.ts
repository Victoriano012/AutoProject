import { z } from "zod";

const dir = z.string().trim().min(1);
const ticketId = z.string().min(1);
const message = z.string().trim().min(1);
export const runRequestSchema = z.discriminatedUnion("action", [
  z.object({ dir, action: z.literal("runTicket"), ticketId }),
  z.object({ dir, action: z.literal("stopTicket"), ticketId }),
  z.object({ dir, action: z.literal("approveTicket"), ticketId }),
  z.object({ dir, action: z.literal("sendFeedback"), ticketId, message }),
  z.object({ dir, action: z.literal("noteTicket"), ticketId, message }),
  z.object({ dir, action: z.literal("rejectTicket"), ticketId, message }),
  z.object({ dir, action: z.literal("runProject") }),
  z.object({ dir, action: z.literal("stopProject") }),
  z.object({ dir, action: z.literal("settleZombies") }),
  z.object({ dir, action: z.literal("removeTickets"), ticketIds: z.array(ticketId).min(1) }),
]);
export type RunRequest = z.infer<typeof runRequestSchema>;

export const agentRequestSchema = z.discriminatedUnion("action", [
  z.object({ dir, action: z.literal("send"), mode: z.enum(["panel", "act"]), message }),
  z.object({ dir, action: z.literal("stop") }),
  z.object({ dir, action: z.literal("cancel"), id: z.string().min(1) }),
  z.object({ dir, action: z.literal("retry"), id: z.string().min(1) }),
]);
