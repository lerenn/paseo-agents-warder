import { z } from "zod";
import type { Engine } from "./engine";
import type { Task } from "./store";

export interface ToolContext {
  engine: Engine;
  /** The calling agent. */
  callerId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  run(input: any, ctx: ToolContext): Promise<unknown> | unknown;
}

export class UsageError extends Error {}

const interval = z.number().min(1).max(24 * 60).describe("How often warder should check on the task, in minutes (1 to 1440).");
const until = z
  .string()
  .optional()
  .describe("ISO 8601 time after which the warder stops, e.g. 2026-10-24T09:00:00Z.");

function parseUntil(value: string | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new UsageError(`until must be an ISO 8601 time, got "${value}"`);
  if (at <= Date.now()) throw new UsageError("until is already in the past");
  return at;
}

function summary(task: Task, ctx: ToolContext) {
  return { task_id: task.id, agent_id: task.agentId, task: task.task, interval_minutes: task.intervalMinutes, status: ctx.engine.status(task) };
}

/** The caller may manage a task if it is the task's agent, registered it, or is an ancestor of the agent. */
function manageable(task: Task, ctx: ToolContext): boolean {
  const { callerId, engine } = ctx;
  return callerId === task.agentId || callerId === task.registeredBy || engine.store.isAncestor(callerId, task.agentId);
}

function find(taskId: string, ctx: ToolContext): Task {
  const task = ctx.engine.store.get(taskId);
  if (!task) throw new UsageError(`No warder task "${taskId}". Use warder_list to see yours.`);
  if (!manageable(task, ctx)) throw new UsageError(`Task ${taskId} belongs to agent ${task.agentId}; you did not register it and are not its parent.`);
  return task;
}

export const TOOLS: ToolDef[] = [
  {
    name: "warder_register",
    description:
      "Register a task you are working on or waiting for (a long build, a CI run, a subagent, a review). Warder will prompt you if " +
      "you show no activity for interval_minutes, and tell your parent agent if you stay silent. Returns task_id. Call warder_done when finished.",
    input: z.object({
      task: z.string().min(1).max(500).describe("What you are doing or waiting for."),
      interval_minutes: interval,
      until,
    }),
    run({ task, interval_minutes, until: u }, ctx) {
      const t = ctx.engine.register({
        agentId: ctx.callerId,
        task,
        intervalMinutes: interval_minutes,
        until: parseUntil(u),
        registeredBy: ctx.callerId,
        source: "agent",
      });
      return summary(t, ctx);
    },
  },
  {
    name: "warder_register_subagent",
    description:
      "Register a warder on one of your subagents (you must be its parent or an ancestor). Warder prompts that agent when it goes quiet " +
      "for interval_minutes and notifies you if it stays unresponsive.",
    input: z.object({
      agent_id: z.string().min(1).describe("The subagent to warder."),
      task: z.string().min(1).max(500).describe("What the subagent is expected to be doing."),
      interval_minutes: interval,
      until,
    }),
    run({ agent_id, task, interval_minutes, until: u }, ctx) {
      const { store } = ctx.engine;
      if (!store.isAncestor(ctx.callerId, agent_id)) {
        throw new UsageError(`${agent_id} is not your subagent (or warder has not seen it yet).`);
      }
      if (store.optedOut(agent_id)) throw new UsageError(`${agent_id} (or its parent) opted out of warder with PASEO_WARDER=off.`);
      const t = ctx.engine.register({
        agentId: agent_id,
        task,
        intervalMinutes: interval_minutes,
        until: parseUntil(u),
        registeredBy: ctx.callerId,
        source: "parent",
      });
      return summary(t, ctx);
    },
  },
  {
    name: "warder_update",
    description: "Record progress on a watched task. Counts as activity, so the quiet timer restarts.",
    input: z.object({ task_id: z.string(), note: z.string().min(1).max(1000) }),
    run({ task_id, note }, ctx) {
      const task = find(task_id, ctx);
      if (task.state !== "active") throw new UsageError(`Task ${task_id} is ${task.state}.`);
      ctx.engine.note(task, note);
      return summary(task, ctx);
    },
  },
  {
    name: "warder_done",
    description: "Finish a watched task with its result. Warder stops watching it.",
    input: z.object({ task_id: z.string(), result: z.string().max(2000) }),
    run({ task_id, result }, ctx) {
      const task = find(task_id, ctx);
      if (task.state === "active") ctx.engine.finish(task, "done", result);
      return summary(task, ctx);
    },
  },
  {
    name: "warder_list",
    description: "List active warder tasks you registered, or that warder your subagents.",
    input: z.object({}),
    run(_input, ctx) {
      return ctx.engine.store
        .active()
        .filter((t) => manageable(t, ctx))
        .map((t) => summary(t, ctx));
    },
  },
];
