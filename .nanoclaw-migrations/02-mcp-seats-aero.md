# 02 — Stdio MCP: seats.aero (award flight search)

## Intent

Expose the seats.aero Pro API to Chester for award/mileage flight search. Complements the Kiwi MCP (cash flights). When the user asks "should I burn miles or pay cash?", both MCPs run in parallel.

The MCP wraps the seats.aero API spec ([https://developers.seats.aero/reference](https://developers.seats.aero/reference)) — the upstream `gavgrego/seats.aero-mcp-server` reference is stale and missing endpoints, so the implementation is original.

## Files (v1, all standalone — no upstream collision)

```
container/agent-runner/src/seats-aero/
├── server.ts      # McpServer setup, instructions (≤2048 chars), 2 resources, 4 tools
├── tools.ts       # callSeats() fetch wrapper + 4 tool functions
├── schema.ts      # Zod schemas; airportField regex [A-Z]{3,5} (INDIA is 5-letter)
└── reference.ts   # MULTI_CITY_CODES + SOURCES_REFERENCE (resource content)
```

## Tools exposed

- `get_flights` (Cached Search) — primary tool for "find flights X→Y on date Z"
- `get_trips` — drills into a get_flights row's `ID` for segments/booking_links
- `get_bulk_avail` — program-wide availability dumps
- `get_routes` — list a program's routes

## Wiring (v1, in `container/agent-runner/src/index.ts`)

1. **`McpTokens` interface** — add `seats: string`
2. **Token capture in `main()`**: `seats: process.env.SEATS_API_KEY ?? ''` then `delete process.env.SEATS_API_KEY` (M7 env-scrub pattern)
3. **`seatsMcpPath = path.join(__dirname, 'seats-aero', 'server.js')`**
4. **`mcpServers` entry**:
   ```ts
   seats: {
     command: 'node',
     args: [seatsMcpPath],
     env: { SEATS_API_KEY: mcpTokens.seats },
   },
   ```
5. **`allowedTools`** — add `'mcp__seats__*'`

**Host side**:
- `src/config.ts` — add `'SEATS_API_KEY'` to `readEnvFile` keys list AND `export const SEATS_API_KEY = process.env.SEATS_API_KEY || envConfig.SEATS_API_KEY || '';`
- `src/container-runner.ts` — `if (SEATS_API_KEY) args.push('-e', \`SEATS_API_KEY=${SEATS_API_KEY}\`);` after the existing MCP token blocks
- `.env.example` — add `# SEATS_API_KEY=  # seats.aero Pro API key, get from https://seats.aero/settings`
- `src/container-runner.test.ts` — add `SEATS_API_KEY: ''` to config mock

## Known data-quality gotchas (already documented in server.ts INSTRUCTIONS)

- `Stops` field is buggy. Derive: `stops = AvailabilitySegments.length - 1`
- Segment times are airport-local despite `Z` suffix — don't convert
- `include_trips=true` returns trip summaries only, NOT segments
- Sort segments by `Order` field, not array order
- Multi-city airport codes (NYC, LON, USA, EUR) are CURATED lists, not exhaustive
- Source quirks: qatar/turkish/singapore = no taxes; qantas/emirates/azul/american = no seat counts

## V2 reapplication

V2's agent-runner has `src/providers/` abstraction. The `mcpServers` block likely lives in the same place but under provider-specific config. Find it via `grep -r mcpServers container/agent-runner/src/` in v2.

The seats.aero source files port directly — they're standalone (no v1 deps). Drop `container/agent-runner/src/seats-aero/` in unchanged.

The build script needs to compile the new TS. v2 uses `bun` for some scripts (commit `e93292d fix(agent-runner): spawn built-in MCP server with bun, not node`) — check whether `command: 'node'` should become `command: 'bun'` for the seats stdio MCP.

## Verification

In Discord testing channel: `@Chester find me business-class award flights from JFK to NRT in February`. Should call `mcp__seats__get_flights`, return mileage costs and which programs to book through.
