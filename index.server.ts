import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { cancelTaskRpc, commandRpc, listTasksRpc, stopSupervisionRpc } from "./shared/rpc";
import { warderSettings, type WarderSettings } from "./shared/settings";
import { parseCommand, runCommand } from "./server/command";
import { analyze, lastAssistantText } from "./server/classify";
import { Engine, type Actions } from "./server/engine";
import { WarderHttp } from "./server/http";
import { INTERVAL_ENV, parseInterval } from "./server/interval";
import { applyInjection, CAPABILITY_ENV, scopeApplies, SCOPE_ENV } from "./server/inject";
import { McpServer } from "./server/mcp";
import { Store } from "./server/store";
import { TOOLS } from "./server/tools";

const DEFAULT_PORT = 47822;

type Paseo = PluginHookContext["paseo"];
type HookAgent = { id: string; workspaceId: string | null; parentAgentId: string | null; title: string | null };

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(warderSettings);
  let current: WarderSettings | null = null;
  let settingsError: string | null = null;
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    current = state.status === "ready" ? state.values : null;
    settingsError = state.status === "invalid" ? state.error : null;
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);

  // Hooks hand us the daemon-side SDK; keep the latest for timers and observers.
  let paseo: Paseo | null = null;
  const capture = (ctx: { paseo: Paseo }) => {
    if (paseo === null) {
      paseo = ctx.paseo;
      engine.resume();
    }
    paseo = ctx.paseo;
  };

  const watchers = new Map<string, () => void>();
  const actions: Actions = {
    async send(agentId, text) {
      if (!paseo) throw new Error("Paseo API not available yet");
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    watch(agentId) {
      if (watchers.has(agentId) || !paseo) return;
      const subscription = paseo.agents.ref(agentId).timeline.subscribe((event) => {
        // Warder's own prompt arrives as a user message; it is not the agent doing something.
        const item = (event as { event?: { item?: { type?: string } } }).event?.item;
        if (item?.type === "user_message") {
          engine.userMessage(agentId);
          return;
        }
        engine.activity(agentId);
      });
      watchers.set(agentId, () => (subscription as unknown as () => void)());
    },
    unwatch(agentId) {
      watchers.get(agentId)?.();
      watchers.delete(agentId);
    },
  };
  const store = new Store(process.env.WARDER_STATE ?? undefined);
  const engine = new Engine(store, actions, () => current);

  const http = new WarderHttp({ engine, mcp: new McpServer(TOOLS) });
  let url: string | null = null;
  let startError: string | null = null;
  const port = Number(process.env.WARDER_PORT ?? DEFAULT_PORT);
  // Resumed agents keep the URL they were created with, so the port has to be stable.
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `warder cannot listen on 127.0.0.1:${port}: ${err.message}. Set WARDER_PORT on the daemon.`;
      console.error(startError);
    },
  );

  const known = (agent: HookAgent) => {
    const result = store.upsertAgent(agent.id, { title: agent.title, parentId: agent.parentAgentId, workspaceId: agent.workspaceId });
    engine.childSeen(agent.id);
    return result;
  };

  const removers = [
    server.before("agent.create", async ({ request }, ctx) => {
      capture(ctx);
      await ready;
      // A bad interval fails creation loudly instead of silently dropping the default.
      if (request.env?.[INTERVAL_ENV]) parseInterval(request.env[INTERVAL_ENV]);
      if (!current?.enabled || !scopeApplies(current.scope, request.env)) return;
      await started;
      if (!url) throw new Error(`${startError} Create the agent with ${SCOPE_ENV}=off to skip warder.`);
      return applyInjection(request, { url, capability: store.createSession() });
    }),
    server.before("agent.session_open", ({ request }, ctx) => {
      capture(ctx);
      const capability = request.env[CAPABILITY_ENV];
      if (capability) store.bind(capability, request.agentId);
      const interval = request.env[INTERVAL_ENV];
      let defaultIntervalMinutes: number | undefined;
      try {
        defaultIntervalMinutes = interval ? parseInterval(interval) : undefined;
      } catch (error) {
        console.error(`warder: ${(error as Error).message}`);
      }
      store.upsertAgent(request.agentId, { optOut: request.env[SCOPE_ENV]?.toLowerCase() === "off", defaultIntervalMinutes });
    }),
    server.on("agent.created", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
    }),
    server.on("agent.turn_started", ({ agent }, ctx) => {
      capture(ctx);
      known(agent);
      engine.turnStarted(agent.id);
    }),
    server.on("agent.turn_ended", ({ agent, timeline }, ctx) => {
      capture(ctx);
      known(agent);
      engine.turnEnded(agent.id);
      const heuristics = current?.announcedWork;
      if (!heuristics?.enabled || store.optedOut(agent.id) || store.active(agent.id).length > 0) return;
      const report = analyze(lastAssistantText(timeline as { type: string; text?: string }[]));
      if (report.announcesFutureWork && report.lastStep) {
        engine.register({
          agentId: agent.id,
          task: report.lastStep,
          intervalMinutes: heuristics.intervalMinutes,
          until: null,
          registeredBy: agent.id,
          source: "announced-work",
        });
      }
    }),
    server.on("agent.permission_requested", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, true);
    }),
    server.on("agent.permission_resolved", ({ agent }, ctx) => {
      capture(ctx);
      engine.permission(agent.id, false);
    }),
    server.on("agent.archived", ({ agent }, ctx) => {
      capture(ctx);
      engine.agentArchived(agent.id);
      store.forgetAgentSessions(agent.id);
    }),
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    try {
      await engine.tick();
    } catch (error) {
      console.error("warder: tick failed", error);
    }
    if (!stopped) timer = setTimeout(loop, (current?.tickSeconds ?? 60) * 1000);
  };
  timer = setTimeout(loop, 15_000);

  // Project and workspace names come from the workspace directory; looked up once per agent and kept.
  let namesCheckedAt = 0;
  async function resolveNames(ctx: { paseo: Paseo }) {
    const missing = store.all().filter((t) => {
      const a = store.agent(t.agentId);
      return a?.workspaceId && !(a.projectName && a.workspaceName);
    });
    if (missing.length === 0 || Date.now() - namesCheckedAt < 30_000) return;
    namesCheckedAt = Date.now();
    try {
      const { entries } = await ctx.paseo.workspaces.list();
      const byId = new Map(entries.map((w) => [w.id, w]));
      for (const task of missing) {
        const agent = store.agent(task.agentId);
        const ws = agent?.workspaceId ? byId.get(agent.workspaceId) : undefined;
        if (ws) {
          store.upsertAgent(task.agentId, {
            projectName: ws.projectCustomName || ws.projectDisplayName,
            workspaceName: ws.title || ws.name,
          });
        }
      }
    } catch (error) {
      console.error("warder: workspace lookup failed", error);
    }
  }

  // Children created before warder saw them are only known through the agent list.
  async function seedChildren(ctx: { paseo: Paseo }, parentId: string) {
    try {
      const { entries } = await ctx.paseo.agents.list({ filter: { includeArchived: false } } as never);
      for (const { agent } of entries as { agent: { id: string; title: string | null; workspaceId: string | null; parentAgentId?: string | null; labels?: Record<string, string> } }[]) {
        const parent = agent.parentAgentId ?? agent.labels?.["paseo.parent-agent-id"] ?? null;
        if (parent !== parentId) continue;
        store.upsertAgent(agent.id, { title: agent.title, parentId: parent, workspaceId: agent.workspaceId });
        engine.childSeen(agent.id);
      }
    } catch (error) {
      console.error("warder: agent lookup failed", error);
    }
  }

  server.handle(commandRpc, async ({ agentId, args }, ctx) => {
    capture(ctx);
    await ready;
    const command = parseCommand(args);
    if (command.kind === "supervise") await seedChildren(ctx, agentId);
    const message = await runCommand(engine, agentId, command);
    try {
      await ctx.paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `warder-${Date.now()}`, kind: "warder-note", version: 1, data: { text: message } });
    } catch (error) {
      console.error("warder: could not append the command result", error);
    }
    return { message };
  });
  server.handle(stopSupervisionRpc, ({ agentId }, ctx) => {
    capture(ctx);
    engine.superviseStop(agentId);
    return {};
  });
  server.handle(listTasksRpc, async (_input, ctx) => {
    capture(ctx);
    await resolveNames(ctx);
    return { now: Date.now(), tasks: engine.views(), supervisions: engine.supervisionViews(), settings: current, settingsError, endpoint: { url, error: startError } };
  });
  server.handle(cancelTaskRpc, ({ taskId }, ctx) => {
    capture(ctx);
    const task = store.get(taskId);
    if (task?.state === "active") engine.finish(task, "cancelled");
    return {};
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const remove of removers) remove();
    for (const stop of watchers.values()) stop();
    watchers.clear();
    unsubscribeSettings();
    void http.stop();
  };
}
