Agents Warder keeps long-running agents from going quiet without anyone noticing. An agent (or its parent) registers a task: what is being done or waited for, and how often to check. If the agent shows no timeline activity for that long, Warder prompts it to continue or close the task. If it stays unresponsive, Warder tells the parent agent.

## How it works

Warder gives new agents these MCP tools:

- `warder_register(task, interval_minutes, until?)` registers a task for the calling agent.
- `warder_register_subagent(agent_id, task, interval_minutes, until?)` lets a parent or any ancestor guard one of its subagents.
- `warder_update(task_id, note)` records progress and restarts the quiet timer.
- `warder_done(task_id, result)` finishes the task.
- `warder_list()` lists the tasks the caller registered or guards.

Once a task has been quiet for its interval, the agent gets: "Warder: your task '...' has had no activity for N min. Continue it, or call warder_done / warder_update." Each unanswered ping lengthens the wait for the next one. After a configurable number of unanswered pings the parent (the `paseo.parent-agent-id` label) gets a short notice, and after a higher number Warder stops pinging. A task also ends when it is marked done, when its agent is archived, or when `until` passes.

Warder also watches turns. When an agent's turn ends while its task is still open, and it has stayed idle past a grace period (default 1 min), it gets a prompt (delivered as a steer) telling it to keep working within its turn and call `warder_done` with the result, including its last note. Agents whose turn is still running are never pinged for idleness; the task interval remains only as a backstop for a running agent with no activity at all. Idle pings follow the same backoff, parent notice and give-up limits. Agents idle on a pending permission request are not pinged and show as waiting-permission; archived agents' tasks are closed.

Warder never sends more than one prompt per few seconds across all agents, however many tasks are overdue, and it skips agents with a pending permission request.

## Setup

Warder runs a small HTTP endpoint on `127.0.0.1:47822` that agents' MCP clients connect to; set `WARDER_PORT` on the daemon to change the port. Agents created before Warder was installed do not have the tools. Requires Paseo 0.11.2 or later.

Create an agent with `PASEO_WARDER_INTERVAL` (for example `15m`, `1h30m`, or `900` for seconds) to give it a default check interval. Its `warder_register` calls can then omit `interval_minutes`, and an explicit value still overrides it. A parent guarding that agent with `warder_register_subagent` also gets the agent's default when it omits the interval. Values are rounded up to whole minutes, between 1 minute and 24 hours; an invalid value fails agent creation. Without a default, `interval_minutes` is required.

By default every new agent gets the tools. Create an agent with `PASEO_WARDER=off` to opt it out; its subagents are then never pinged either. With scope `opt-in`, only agents created with `PASEO_WARDER=on` get the tools.

## The /warder command

Type these in an agent's composer. Nothing is sent to the model as a prompt.

- `/warder <task> [--interval <minutes>]` puts the current agent under watch, registered by the user, with the same idle rule as any task (pinged 1 min after it stops without finishing). The agent is told it is watched and must call `warder_update` and `warder_done`. The interval is the hang check, capped by the max interval setting.
- `/warder stop` (or `done`) ends the watch on the current agent.
- `/warder` shows the current watch status.
- `/warder supervise` is for coordinators. It watches the agent's direct child agents, including ones created later, and never applies the idle rule to the coordinator itself. The coordinator is pinged only when a child needs it and it has not reacted within the react delay (default 5 min): a child finished or stopped its turn, waits on a permission request, or hangs with no activity past the hang check. Prompting the child, answering its permission or archiving it counts as reacting. A ping lists the children and why, and each event is reported once. `/warder supervise stop` ends it.

The result of each command appears as a note in the agent's timeline. The screen shows supervision as "supervising N agents · M need attention".

## Settings

- Scope, tick interval (default 1 min), idle grace period and the global gap between prompts.
- How long a supervising coordinator has to react to a child before it is pinged.
- Backoff factor and its cap, when to notify the parent, and when to give up.
- The ping and parent notice templates (`{{task}}`, `{{minutes}}`, `{{title}}`, `{{agentId}}`, `{{pings}}`).
- Announced-work detection, off by default: registers a task automatically when an agent ends a turn saying it will keep watching or check back later.

## Screen

The Agents Warder screen under the sidebar lists tasks with agent, interval, last activity, pings sent and status (ok, pinged, escalated, waiting-permission, done, expired, archived, gave-up), and lets you stop one.

## Data

Tasks and per-agent tokens are stored in `~/.paseo/plugin-data/agents-warder/state.json` on the daemon machine. Warder sends prompts only to agents on the same daemon and makes no network calls.
