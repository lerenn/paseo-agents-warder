# paseo-agents-warder

A [Paseo](https://paseo.sh) plugin that keeps agents from silently stalling. Agents register tasks with explicit check intervals; Warder prompts them when they go quiet and notifies their parent when they stay silent. See [OVERVIEW.md](OVERVIEW.md) for behavior and settings.

Registry id: `lerenn/agents-warder`.

## Layout

- `index.server.ts`: lifecycle hooks, MCP injection, tick loop, RPCs.
- `server/engine.ts`: task evaluation, pings, backoff, global pacing, parent notice. Pure given injected clock and actions.
- `server/tools.ts`, `server/mcp.ts`, `server/http.ts`: the MCP tools and the loopback endpoint.
- `server/store.ts`: persisted tasks, agents and capability tokens.
- `server/classify.ts`: optional announced-work detection.
- `server/command.ts`: the `/warder` slash command (watch, stop, status, supervise).
- `client/screen.tsx`: the Agents Warder screen. `client/note.tsx`: command result rows.

## Develop

```bash
npm ci
npm run typecheck && npm test && npm run build
```

CI runs the same through Dagger (`dagger call all`).

Environment: `WARDER_PORT` (endpoint port), `WARDER_STATE` (state file, mainly for tests), `PASEO_WARDER=off|on` and `PASEO_WARDER_INTERVAL` (default check interval, e.g. `15m`; per-agent, at creation).
