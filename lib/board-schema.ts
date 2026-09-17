import { z } from "zod";

/** One contract drives Claude's board tool, CLI JSON Schema, and validation of
 * completed planner responses. Strict objects reject misspelled fields. */
export const plannedTicketSchema = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string(),
  files: z.array(z.string().trim().min(1)),
  worker: z.union([
    z.strictObject({ existing: z.number().int().positive() }),
    z.strictObject({ new: z.string().trim().min(1) }),
  ]),
});

export const addTicketsSchema = z.strictObject({ tickets: z.array(plannedTicketSchema) });
export const notesSchema = z.strictObject({ notes: z.array(z.string()) });
export const requestJsonSchema = z.toJSONSchema(addTicketsSchema, { target: "draft-7" });

export function parsePlannedTickets(output: unknown): z.infer<typeof plannedTicketSchema>[] {
  return addTicketsSchema.parse(output).tickets;
}
