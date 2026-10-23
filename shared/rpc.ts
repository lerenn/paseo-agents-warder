import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { settingsSchema } from "./settings";
import { taskViewSchema } from "./task";

export const listTasksRpc = defineRpc({
  name: "warder.list",
  input: z.object({}),
  output: z.object({
    now: z.number(),
    tasks: z.array(taskViewSchema),
    settings: settingsSchema.nullable(),
    settingsError: z.string().nullable(),
    /** Base URL of the MCP endpoint, or why it is not running. */
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
});

export const cancelTaskRpc = defineRpc({
  name: "warder.cancel",
  input: z.object({ taskId: z.string() }),
  output: z.object({}),
});
