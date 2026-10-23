import { describe, expect, it } from "vitest";
import { applyInjection, CAPABILITY_ENV, scopeApplies } from "./inject";

describe("scopeApplies", () => {
  it("scope all: everyone but PASEO_WARDER=off", () => {
    expect(scopeApplies("all", undefined)).toBe(true);
    expect(scopeApplies("all", { PASEO_WARDER: "on" })).toBe(true);
    expect(scopeApplies("all", { PASEO_WARDER: "off" })).toBe(false);
  });
  it("scope opt-in: only PASEO_WARDER=on", () => {
    expect(scopeApplies("opt-in", {})).toBe(false);
    expect(scopeApplies("opt-in", { PASEO_WARDER: "on" })).toBe(true);
    expect(scopeApplies("opt-in", { PASEO_WARDER: "off" })).toBe(false);
  });
});

describe("applyInjection", () => {
  const request = {
    config: { provider: "claude", cwd: "/w", systemPrompt: "base", mcpServers: { other: { type: "http" as const, url: "http://x" } } },
    env: { A: "1" },
  } as never;

  it("adds the MCP server, capability env, preapproved tools and a prompt note", () => {
    const out: any = applyInjection(request, { url: "http://127.0.0.1:1", capability: "cap" });
    expect(out.config.mcpServers.warder).toMatchObject({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer cap" } });
    expect(out.config.mcpServers.other).toBeDefined();
    expect(out.env).toEqual({ A: "1", [CAPABILITY_ENV]: "cap" });
    expect(out.config.toolPolicy.preapproved.map((t: any) => t.tool)).toContain("warder_done");
    expect(out.config.systemPrompt).toMatch(/^base\n\nWarder:/);
  });
});
