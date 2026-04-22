/**
 * Stdio MCP server exposing seats.aero flight-search tools.
 * Spawned by the agent-runner alongside the nanoclaw stdio MCP.
 *
 * Reads SEATS_API_KEY from env (host passes it via -e at container spawn,
 * agent-runner deletes it from process.env after capturing for this server's
 * env, so Bash subprocesses can't echo it).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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

const server = new McpServer({
  name: 'seats-aero',
  version: '1.0.0',
});

// Tool descriptions quote the official endpoint-selection guidance from
// https://developers.seats.aero/reference/concepts-copy where available,
// and add operational hints (multi-airport syntax, the search→trips
// drill-down) where the docs are silent. All four endpoints count
// 1-for-1 against the same 1,000/day Pro quota.

server.tool(
  'get_flights',
  // Quoted from Concepts: "Cached Search is the most common endpoint... allows you
  // to search for availability between specific airports within specific date ranges
  // across all mileage programs."
  'Cached Search — the most common endpoint. Searches cached award availability ' +
    'between specific airports within specific date ranges, across all mileage programs. ' +
    'originAirport and destinationAirport accept a single IATA code or a comma-delimited ' +
    'list ("JFK,EWR" → "NRT,HND"). cabins is comma-delimited ("business,first"). sources ' +
    'restricts to specific mileage programs ("aeroplan,united"). Each row\'s top-level "ID" ' +
    'field is the Availability summary ID — pass it to get_trips for flight-level details ' +
    '(flight numbers, segments, times). Data is cached, so always tell the user to confirm ' +
    'on the airline site before booking.',
  GetFlightsSchema,
  async (args) => getFlights(args as GetFlightsArgs),
);

server.tool(
  'get_trips',
  // Quoted from Concepts: "you call the Get Trips API with the ID of the Availability"
  'Get Trips — drills into a summary Availability object. Per the seats.aero docs, ' +
    '"you call the Get Trips API with the ID of the Availability" — pass the top-level "ID" ' +
    'field of a get_flights row (NOT items from its AvailabilityTrips field). The response ' +
    'contains all individual trips for that Availability, with flight numbers, segments, ' +
    'departure/arrival times, aircraft, mileage cost, taxes, remaining seats, and booking links.',
  GetTripsSchema,
  async (args) => getTrips(args as GetTripsArgs),
);

server.tool(
  'get_bulk_avail',
  // Quoted from Concepts: "Bulk Availability... allows you to retrieve a large amount of
  // availability for one specific mileage program... when many results are required."
  'Bulk Availability — for "many results" use cases. Retrieves a large amount of cached ' +
    'availability for one specific mileage program, optionally narrowed by cabin, date range, ' +
    'or origin/destination region. Region values are exactly: "North America", "South America", ' +
    '"Africa", "Asia", "Europe", "Oceania". Use this for program-wide browsing (e.g. "all ' +
    'availability from North America to Europe on Delta SkyMiles") rather than for known ' +
    'origin/destination searches — those go through get_flights.',
  GetBulkAvailSchema,
  async (args) => getBulkAvail(args as GetBulkAvailArgs),
);

server.tool(
  'get_routes',
  'Get Routes — returns the list of routes a single mileage program flies. Useful when ' +
    'the user asks "what does <program> fly" or you need to confirm an origin/destination ' +
    'is even in a program\'s network before searching availability.',
  GetRoutesSchema,
  async (args) => getRoutes(args as GetRoutesArgs),
);

const transport = new StdioServerTransport();
await server.connect(transport);
