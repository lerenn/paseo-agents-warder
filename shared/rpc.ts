import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { settingsSchema } from "./settings";
import { supervisionViewSchema, taskViewSchema } from "./task";

export const listTasksRpc = defineRpc({
  name: "warder.list",
  input: z.object({}),
  output: z.object({
    now: z.number(),
    tasks: z.array(taskViewSchema),
    supervisions: z.array(supervisionViewSchema),
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

export const stopSupervisionRpc = defineRpc({
  name: "warder.unsupervise",
  input: z.object({ agentId: z.string() }),
  output: z.object({}),
});

/** The `/warder` slash command: the raw text after the command name, for the current agent. */
export const commandRpc = defineRpc({
  name: "warder.command",
  input: z.object({ agentId: z.string(), args: z.string() }),
  output: z.object({ message: z.string() }),
});
