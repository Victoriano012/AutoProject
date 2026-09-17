import { z } from "zod";

const text = z.string().max(1_000_000);
const pathText = z.string().min(1).max(4096).refine((s) => !s.includes("\0"), "Invalid path");
export const attachmentSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(255), mediaType: z.string().max(255),
  dataUrl: z.string().max(4_200_000).regex(/^data:/),
}).strict();
const attachments = z.array(attachmentSchema).max(50);
const statusSchema = z.enum(["todo", "running", "review", "done", "error"]);
const projectValues = {
  name: z.string().min(1).max(255), description: text, workspaceDir: z.string().max(4096).refine((s) => !s.includes("\0")),
  attachments: attachments.nullable(), notes: z.array(text).max(1000),
  metaPosition: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().nullable(),
};
const ticketValues = {
  title: z.string().max(1000), description: text, files: z.array(pathText).max(10000).nullable(),
  attachments: attachments.nullable(), paused: z.boolean().nullable(),
};
const projectChanges = Object.entries(projectValues).map(([field, schema]) => z.object({
  scope: z.literal("project"), field: z.literal(field), before: schema.nullable(), value: schema,
}).strict());
const ticketChanges = Object.entries(ticketValues).map(([field, schema]) => z.object({
  scope: z.literal("ticket"), id: z.string().min(1).max(255), field: z.literal(field), before: schema.nullable(), value: schema,
}).strict());
export const projectPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  changes: z.union([...projectChanges, ...ticketChanges]).array().max(10000),
  edits: z.array(z.object({ id: z.string().min(1), before: statusSchema, status: z.literal("todo") }).strict()).max(10000),
}).strict();
export const createProjectSchema = z.union([
  z.object({ name: z.string().trim().min(1).max(255).refine((s) => s !== "." && s !== "..", "Invalid project name") }).strict(),
  z.object({ path: pathText }).strict(),
]);
