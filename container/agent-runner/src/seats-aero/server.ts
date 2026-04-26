/**
 * Stdio MCP server exposing seats.aero flight-search tools.
 * Spawned by the agent-runner alongside the nanoclaw stdio MCP.
 *
 * Reads SEATS_API_KEY from env (host passes it via -e at container spawn,
 * agent-runner deletes it from process.env after capturing for this server's
 * env, so Bash subprocesses can't echo it).
 *
 * Server-level guidance is provided three ways:
 *   1. `instructions` (≤2048 chars, hard cap in the SDK) — essential
 *      gotchas/workflow surfaced into the system prompt automatically.
 *   2. Resources at seats-aero://* — bulky reference material the agent
 *      reads on demand (multi-city codes, sources list).
 *   3. Per-tool descriptions — narrow guidance specific to one tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MULTI_CITY_CODES, SOURCES_REFERENCE } from './reference.js';
import {
  GetBulkAvailSchema,
  GetFlightsSchema,
  GetRoutesSchema,
  GetTripsSchema,
} from './schema.js';
import {
  GetBulkAvailArgs,
  GetFlightsArgs,
  GetRoutesArgs,
  GetTripsArgs,
  getBulkAvail,
  getFlights,
  getRoutes,
  getTrips,
} from './tools.js';

// Server-level instructions. Surfaced into the agent's system prompt by
// the SDK's MCP client. Hard cap = 2048 chars (anything longer gets
// truncated). Keep this as the essential operating manual; push detail
// into resources or tool descriptions.
const INSTRUCTIONS = `Award-flight search via seats.aero (mileage/points, NOT cash).

ENDPOINTS:
- get_flights (Cached Search) — default for "find flights X→Y on date Z".
- get_trips — drill into a get_flights row by passing the row's TOP-LEVEL \`ID\` field (NOT items from its AvailabilityTrips field). Returns flight numbers, segments, times, aircraft, and top-level booking_links.
- get_bulk_avail — only for "what does program X have available" queries. Large payloads.
- get_routes — rare; "what routes does program X fly".

WORKFLOW: get_flights → pick top 1-3 cheapest rows → get_trips on each row's ID → summarize. Always tell user to verify on the airline site before booking.

QUOTA: 1000 calls/day, midnight-UTC reset. \`X-RateLimit-Remaining\` in every response. Calls count by NUMBER, not size — default take=1000.

DATA-QUALITY GOTCHAS:
- \`Stops\` field is buggy (saw Qantas QF4 nonstop reported as Stops:1). Always derive: stops = AvailabilitySegments.length - 1.
- Segment times are airport-LOCAL despite the Z suffix — don't convert across timezones. Use trip-level \`TotalDuration\` (minutes) for total time.
- include_trips=true returns trip summaries only, NOT segments. Still need get_trips for per-leg detail.
- Sort segments by their \`Order\` field, not array order.
- get_flights rows have *Direct fields (e.g. JDirectMileageCost) that give nonstop-only metrics — use these to answer "is the nonstop more miles than cheapest with connection?" without an extra get_trips call.

PROGRAM QUIRKS: qatar/turkish/singapore = no taxes returned. qantas/emirates/connectmiles/azul/american (mostly) = no seat counts. eurobonus = economy + business only.

MULTI-CITY CODES: airport fields accept seats.aero 3-letter codes (NYC, LON, USA, EUR, UAH, etc.). Codes are CURATED ("Large Airports") lists, NOT exhaustive. Read seats-aero://codes/multi-city for the full table.

SOURCES: free string; pass any user-mentioned program. Read seats-aero://sources for the canonical list with cabin support and quirks.

Live Search not available on Pro tier.`;

const server = new McpServer(
  {
    name: 'seats-aero',
    version: '1.0.0',
  },
  {
    instructions: INSTRUCTIONS,
  },
);

// --- Resources ----------------------------------------------------

server.registerResource(
  'multi-city-codes',
  'seats-aero://codes/multi-city',
  {
    title: 'seats.aero multi-city codes (full mappings)',
    description:
      'Complete table of 3-letter codes (NYC, LON, USA, EUR, UAH, etc.) and ' +
      'the airports each one expands to. Read this when the user asks "what ' +
      'does code X include?" or "is airport Y in code Z?".',
    mimeType: 'text/markdown',
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: MULTI_CITY_CODES }],
  }),
);

server.registerResource(
  'sources',
  'seats-aero://sources',
  {
    title: 'seats.aero canonical mileage program sources',
    description:
      'Table of the 26 documented mileage programs accepted as `source` / ' +
      '`sources` parameters, with cabin support (Y/W/J/F), seat-count and ' +
      'trip-data availability per program. List is not exhaustive — pass any ' +
      'user-mentioned program; the API 400s on unknown values.',
    mimeType: 'text/markdown',
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SOURCES_REFERENCE }],
  }),
);

// --- Tools --------------------------------------------------------
//
// Tool descriptions stay narrow — server-level workflow/gotchas live in
// `instructions` above, bulky reference data in resources.

server.tool(
  'get_flights',
  'Cached Search: cached award availability between airports on date(s). ' +
    'See server instructions for workflow + multi-city codes.',
  GetFlightsSchema,
  async (args) => getFlights(args as GetFlightsArgs),
);

server.tool(
  'get_trips',
  "Get Trips: pass the top-level `ID` of a get_flights row to get its trips " +
    '(flight numbers, segments, times, aircraft, booking links).',
  GetTripsSchema,
  async (args) => getTrips(args as GetTripsArgs),
);

server.tool(
  'get_bulk_avail',
  'Bulk Availability: cached availability for one mileage program, optionally ' +
    'narrowed by cabin/dates/region. Region values: "North America", "South ' +
    'America", "Africa", "Asia", "Europe", "Oceania". Use for program-wide ' +
    'browsing; for known origin/destination searches use get_flights.',
  GetBulkAvailSchema,
  async (args) => getBulkAvail(args as GetBulkAvailArgs),
);

server.tool(
  'get_routes',
  "Get Routes: list the routes a single program flies. Useful for \"what does " +
    'X fly\" or to confirm an origin/destination is in the network.',
  GetRoutesSchema,
  async (args) => getRoutes(args as GetRoutesArgs),
);

const transport = new StdioServerTransport();
await server.connect(transport);
