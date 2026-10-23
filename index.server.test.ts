import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import contribute from "./index.server";
import { settingsSchema } from "./shared/settings";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(settings: object = {}) {
  process.env.WARDER_PORT = "0";
  process.env.WARDER_STATE = path.join(mkdtempSync(path.join(tmpdir(), "warder-")), "state.json");
  const handlers: Record<string, any> = {};
  const sent: { id: string; text: string }[] = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        send: async (text: string) => void sent.push({ id, text }),
        timeline: { subscribe: () => () => {} },
      }),
    },
  };
  const ctx = { paseo, signal: new AbortController().signal };
  const values = settingsSchema.parse(settings);
  const cleanup = contribute({
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values }), subscribe: () => () => {} }),
    before: (name: string, h: any) => ((handlers[name] = h), () => {}),
    on: (name: string, h: any) => ((handlers[name] = h), () => {}),
    handle: (contract: { name: string }, h: any) => ((handlers[contract.name] = h), undefined),
  } as never);
  cleanups.push(cleanup as () => void);
  return { handlers, ctx, sent };
}

const request = (env?: Record<string, string>) => ({ request: { config: { provider: "claude", cwd: "/w" }, env } });

describe("plugin entry", () => {
  it("injects the warder MCP server into new agents", async () => {
    const { handlers, ctx } = boot();
    const out = await handlers["agent.create"](request(), ctx);
    expect(out.config.mcpServers.warder.type).toBe("http");
    expect(out.env.PASEO_WARDER_CAPABILITY).toBeTruthy();
  });

  it("leaves PASEO_WARDER=off agents alone", async () => {
    const { handlers, ctx } = boot();
    expect(await handlers["agent.create"](request({ PASEO_WARDER: "off" }), ctx)).toBeUndefined();
  });

  it("with announced-work on, registers a task for an agent that ends a turn announcing work", async () => {
    const { handlers, ctx } = boot({ announcedWork: { enabled: true, intervalMinutes: 5 } });
    await handlers["agent.create"](request(), ctx); // waits for settings
    const agent = { id: "a1", workspaceId: "w", parentAgentId: null, title: "T" };
    handlers["agent.turn_ended"]({ agent, turnId: "1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "Build started. I'll keep watching CI." }] }, ctx);
    const list = await handlers["warder.list"]({}, ctx);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({ agentId: "a1", source: "announced-work" });
  });

  it("does not register by heuristic when it is off (default)", async () => {
    const { handlers, ctx } = boot();
    await handlers["agent.create"](request(), ctx);
    const agent = { id: "a2", workspaceId: "w", parentAgentId: null, title: "T" };
    handlers["agent.turn_ended"]({ agent, turnId: "1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "I'll keep watching CI." }] }, ctx);
    expect((await handlers["warder.list"]({}, ctx)).tasks).toEqual([]);
  });
});
