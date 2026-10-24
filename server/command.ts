import type { Engine } from "./engine";
import type { Task } from "./store";

export const USER = "user";

export interface Command {
  kind: "status" | "stop" | "supervise" | "supervise-stop" | "watch";
  task?: string;
  intervalMinutes?: number;
}

const USAGE = "Usage: /warder <task> [--interval <minutes>] | /warder stop | /warder supervise [stop] | /warder";

/** Parse the text after `/warder`. Throws a readable error on a bad interval. */
export function parseCommand(args: string): Command {
  const text = args.trim();
  if (!text) return { kind: "status" };
  const lower = text.toLowerCase();
  if (lower === "stop" || lower === "done") return { kind: "stop" };
  if (lower === "supervise") return { kind: "supervise" };
  if (lower === "supervise stop") return { kind: "supervise-stop" };
  const match = /(?:^|\s)--interval(?:=|\s+)(\S+)(?=\s|$)/.exec(text);
  let intervalMinutes: number | undefined;
  let task = text;
  if (match) {
    intervalMinutes = Number(match[1].replace(/m$/i, ""));
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 24 * 60) {
      throw new Error(`--interval must be 1 to 1440 minutes, got "${match[1]}". ${USAGE}`);
    }
    task = (text.slice(0, match.index) + " " + text.slice(match.index + match[0].length)).trim();
  }
  if (!task) throw new Error(USAGE);
  return { kind: "watch", task: task.slice(0, 500), intervalMinutes };
}

function describe(task: Task, engine: Engine): string {
  const by = task.registeredBy === USER ? "you" : task.registeredBy === task.agentId ? "the agent" : task.registeredBy;
  return `'${task.task}' (${engine.status(task)}, registered by ${by}, hang check ${Math.min(task.intervalMinutes, engine.defaultIntervalMinutes())} min)`;
}

/** Run a parsed command for `agentId`; returns the text shown to the user. */
export async function runCommand(engine: Engine, agentId: string, command: Command): Promise<string> {
  const { store } = engine;
  switch (command.kind) {
    case "status": {
      const tasks = store.active(agentId);
      const lines = tasks.map((t) => `Watching ${describe(t, engine)}`);
      if (store.supervising(agentId)) {
        const v = engine.supervisionViews().find((x) => x.agentId === agentId);
        lines.push(`Supervising ${v?.children ?? 0} agents · ${v?.needAttention ?? 0} need attention`);
      }
      return lines.length > 0 ? `Warder: ${lines.join("\n")}` : "Warder: this agent is not watched. Use /warder <task> to watch it.";
    }
    case "stop": {
      const tasks = store.active(agentId);
      const supervised = engine.superviseStop(agentId);
      for (const task of tasks) engine.finish(task, "cancelled", "Stopped by the user");
      if (tasks.length === 0 && !supervised) return "Warder: nothing to stop, this agent is not watched.";
      if (tasks.length > 0) {
        await engine.notify(agentId, `Warder: the user ended the watch on '${tasks.map((t) => t.task).join("', '")}'. You no longer need to call warder_update or warder_done for it.`);
      }
      return `Warder: stopped watching this agent${supervised ? " and its supervision" : ""}.`;
    }
    case "supervise":
      engine.supervise(agentId);
      return "Warder: supervising this agent's children. You are pinged only when a child needs you and you have not reacted in time.";
    case "supervise-stop":
      return engine.superviseStop(agentId) ? "Warder: stopped supervising." : "Warder: this agent was not supervising.";
    case "watch": {
      for (const old of store.active(agentId).filter((t) => t.registeredBy === USER)) engine.finish(old, "cancelled", "Replaced by a new /warder task");
      const task = engine.register({
        agentId,
        task: command.task!,
        intervalMinutes: command.intervalMinutes ?? store.agent(agentId)?.defaultIntervalMinutes ?? engine.defaultIntervalMinutes(),
        until: null,
        registeredBy: USER,
        source: "user",
      });
      await engine.notify(
        agentId,
        `Warder: the user put you under watch for "${task.task}" (task ${task.id}). Keep working until it is done: call warder_update with progress and warder_done with task_id ${task.id} and the result when finished. ` +
          "You are pinged if your turn ends without warder_done.",
      );
      return `Warder: watching this agent for "${task.task}" (task ${task.id}). It is pinged 1 min after it stops without finishing; hang check ${task.intervalMinutes} min.`;
    }
  }
}
