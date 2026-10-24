import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_PING_TEMPLATE =
  "Warder: your task '{{task}}' has had no activity for {{minutes}} min. " +
  "Continue it, or call warder_done / warder_update.";
export const DEFAULT_IDLE_PING_TEMPLATE =
  "Warder: your turn ended {{minutes}} min ago but your task '{{task}}' is not finished. " +
  "Keep working within your turn until it is done, then call warder_done with the result, including your last note.";
export const DEFAULT_PARENT_TEMPLATE =
  "Warder: agent '{{title}}' ({{agentId}}) has not answered {{pings}} pings on its task '{{task}}' " +
  "(no activity for {{minutes}} min).";

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Who gets the warder tools. "all": every new agent except those created with PASEO_WARDER=off.
   * "opt-in": only agents created with PASEO_WARDER=on.
   */
  scope: z.enum(["all", "opt-in"]).default("all"),
  /** How often tasks are evaluated. */
  tickSeconds: z.number().int().min(5).default(60),
  /** Never send more than one warder prompt (ping or parent notice) within this window, across all agents. */
  globalGapSeconds: z.number().int().min(1).default(30),
  /** Ping an agent whose turn ended without warder_done once it has been idle this long. Running agents are never pinged for idleness. */
  idleGraceSeconds: z.number().int().min(0).default(60),
  /** Hang backstop: the longest a running agent may stay silent before a ping. Longer agent-registered intervals are clamped to it, and it is the default interval. */
  maxIntervalMinutes: z.number().min(1).default(15),
  /** Each unanswered ping multiplies the wait for the next one by this factor... */
  backoffFactor: z.number().min(1).default(2),
  /** ...up to this many intervals. */
  maxBackoffIntervals: z.number().min(1).default(8),
  /** Notify the parent after this many unanswered pings. */
  notifyParentAfterPings: z.number().int().min(1).default(3),
  /** Stop pinging a task after this many unanswered pings (the parent is notified). */
  maxUnansweredPings: z.number().int().min(1).default(6),
  pingTemplate: z.string().default(DEFAULT_PING_TEMPLATE),
  idlePingTemplate: z.string().default(DEFAULT_IDLE_PING_TEMPLATE),
  parentTemplate: z.string().default(DEFAULT_PARENT_TEMPLATE),
  /**
   * Optional extra, off by default: when an agent without a warder ends a turn announcing future work
   * ("I'll keep watching"), register a warder for it automatically.
   */
  announcedWork: z
    .object({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().min(1).default(10),
    })
    .default({ enabled: false, intervalMinutes: 10 }),
});
export type WarderSettings = z.output<typeof settingsSchema>;

export const warderSettings = defineSettings({
  id: "warder",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
