import { z } from "zod";

export const taskStatusSchema = z.enum([
  "ok",
  "pinged",
  "escalated",
  "waiting-permission",
  "gave-up",
  "done",
  "expired",
  "archived",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  parentId: z.string().nullable(),
  task: z.string(),
  intervalMinutes: z.number(),
  until: z.number().nullable(),
  registeredBy: z.string(),
  source: z.enum(["agent", "parent", "announced-work"]),
  status: taskStatusSchema,
  createdAt: z.number(),
  lastActivityAt: z.number(),
  lastPingAt: z.number().nullable(),
  pings: z.number(),
  unanswered: z.number(),
  notes: z.array(z.object({ at: z.number(), text: z.string() })),
  result: z.string().nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
