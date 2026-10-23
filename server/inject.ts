import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "warder";
export const SCOPE_ENV = "PASEO_WARDER";
export const CAPABILITY_ENV = "PASEO_WARDER_CAPABILITY";
export const TOOL_NAMES = ["warder_register", "warder_register_subagent", "warder_update", "warder_done", "warder_list"];

export function scopeApplies(scope: "all" | "opt-in", env: Record<string, string> | undefined): boolean {
  const value = env?.[SCOPE_ENV]?.toLowerCase();
  if (value === "off") return false;
  return scope === "all" || value === "on";
}

const NOTE =
  "Warder: for long work or anything you wait on (builds, CI, reviews, subagents), call warder_register(task, interval_minutes) so you " +
  "get a prompt if you go quiet. Call warder_update with progress and warder_done when finished. " +
  "If you manage subagents, warder_register_subagent watches one of them.";

export function applyInjection(request: CreateRequest, o: { url: string; capability: string }): CreateRequest {
  const preapproved = request.config.toolPolicy?.preapproved ?? [];
  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: [request.config.systemPrompt, NOTE].filter(Boolean).join("\n\n"),
      mcpServers: {
        ...request.config.mcpServers,
        [SERVER_NAME]: { type: "http", url: `${o.url}/mcp`, headers: { authorization: `Bearer ${o.capability}` }, alwaysLoad: true },
      },
      toolPolicy: {
        ...request.config.toolPolicy,
        preapproved: [...preapproved, ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool }))],
      },
    },
    env: { ...request.env, [CAPABILITY_ENV]: o.capability },
  };
}
