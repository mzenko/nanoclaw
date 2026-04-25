# 03 — Remote MCP: Kiwi flights (cash)

## Intent

Cash/revenue flight search via Kiwi.com's official remote MCP. Pairs with seats.aero for "miles vs cash" parallel queries.

## Implementation

Single entry in `container/agent-runner/src/index.ts` mcpServers block:

```ts
'kiwi-flights': {
  type: 'http',
  url: 'https://mcp.kiwi.com',
},
```

And `'mcp__kiwi-flights__*'` added to `allowedTools`.

That's it — no token, no source files, no config wiring. Kiwi runs the MCP server themselves.

## V2 reapplication

Same deal — one line in v2's mcpServers block, one line in allowedTools.

## Verification

`@Chester what does it cost to fly JFK to NRT round-trip in February?` — should call `mcp__kiwi-flights__search-flight` with a booking link.
