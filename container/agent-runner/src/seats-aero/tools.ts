// Vendored from gavgrego/seats.aero-mcp-server, but rewritten against the
// real seats.aero API spec (https://developers.seats.aero/reference) — the
// upstream has several stale params and is missing get_trips.

const BASE_URL = 'https://seats.aero/partnerapi';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

type SeatsResponse =
  | { kind: 'ok'; data: unknown; remaining: string | null }
  | { kind: 'err'; result: ToolResult };

async function callSeats(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<SeatsResponse> {
  const apiKey = process.env.SEATS_API_KEY;
  if (!apiKey) {
    return {
      kind: 'err',
      result: err(
        'SEATS_API_KEY is not set in the seats MCP subprocess env. Add it to the host .env and restart the service.',
      ),
    };
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.append(k, String(v));
  }

  const qs = params.toString();
  const url = qs ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'Partner-Authorization': apiKey,
    },
  });

  // seats.aero exposes the daily quota in a response header. Surface it so
  // the user can see how much budget is left in a turn.
  const remaining =
    res.headers.get('x-ratelimit-remaining') ??
    res.headers.get('ratelimit-remaining') ??
    null;

  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    return {
      kind: 'err',
      result: err(
        `seats.aero API error (HTTP ${res.status})${
          remaining ? ` [${remaining} calls remaining today]` : ''
        }: ${body.slice(0, 500)}`,
      ),
    };
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    return {
      kind: 'err',
      result: err('seats.aero returned an empty/unparseable response.'),
    };
  }
  return { kind: 'ok', data, remaining };
}

function format(label: string, response: SeatsResponse): ToolResult {
  if (response.kind === 'err') return response.result;
  const quota = response.remaining
    ? ` (${response.remaining} calls remaining today)`
    : '';
  return ok(`${label}${quota}:\n\n${JSON.stringify(response.data, null, 2)}`);
}

// --- get_flights (cached search) -----------------------------------

export interface GetFlightsArgs {
  originAirport: string;
  destinationAirport: string;
  startDate?: string;
  endDate?: string;
  cabins?: string;
  sources?: string;
  carriers?: string;
  only_direct_flights?: boolean;
  include_trips?: boolean;
  minify_trips?: boolean;
  include_filtered?: boolean;
  order_by?: '' | 'lowest_mileage';
  take?: number;
  skip?: number;
  cursor?: number;
}

export async function getFlights(args: GetFlightsArgs): Promise<ToolResult> {
  const result = await callSeats('/search', {
    origin_airport: args.originAirport,
    destination_airport: args.destinationAirport,
    start_date: args.startDate,
    end_date: args.endDate,
    cabins: args.cabins,
    sources: args.sources,
    carriers: args.carriers,
    only_direct_flights: args.only_direct_flights,
    include_trips: args.include_trips,
    minify_trips: args.minify_trips,
    include_filtered: args.include_filtered,
    order_by: args.order_by ?? 'lowest_mileage',
    // Default take to the API max (1000). Each call counts as 1 against the
    // daily quota regardless of payload size, so smaller take saves nothing.
    take: args.take ?? 1000,
    skip: args.skip,
    cursor: args.cursor,
  });
  return format(
    `Award flights ${args.originAirport} → ${args.destinationAirport}`,
    result,
  );
}

// --- get_bulk_avail ------------------------------------------------

export interface GetBulkAvailArgs {
  source: string;
  cabin?: 'economy' | 'premium' | 'business' | 'first';
  startDate?: string;
  endDate?: string;
  originRegion?: string;
  destinationRegion?: string;
  include_filtered?: boolean;
  take?: number;
  skip?: number;
  cursor?: number;
}

export async function getBulkAvail(args: GetBulkAvailArgs): Promise<ToolResult> {
  const result = await callSeats('/availability', {
    source: args.source,
    cabin: args.cabin,
    start_date: args.startDate,
    end_date: args.endDate,
    origin_region: args.originRegion,
    destination_region: args.destinationRegion,
    include_filtered: args.include_filtered,
    // Default take to the API max (1000). Each call counts as 1 against the
    // daily quota regardless of payload size, so smaller take saves nothing.
    take: args.take ?? 1000,
    skip: args.skip,
    cursor: args.cursor,
  });
  return format(`Bulk availability on ${args.source}`, result);
}

// --- get_routes ----------------------------------------------------

export interface GetRoutesArgs {
  source: string;
}

export async function getRoutes(args: GetRoutesArgs): Promise<ToolResult> {
  const result = await callSeats('/routes', { source: args.source });
  return format(`Routes for ${args.source}`, result);
}

// --- get_trips -----------------------------------------------------
//
// The cached-search rows include an AvailabilityTrips field — a comma-
// delimited list of trip IDs. Calling /trips/{id} returns the actual
// flight numbers, segments, times, aircraft, and booking links.

export interface GetTripsArgs {
  id: string;
  include_filtered?: boolean;
}

export async function getTrips(args: GetTripsArgs): Promise<ToolResult> {
  // Path param — must be URL-encoded, query goes alongside.
  const id = encodeURIComponent(args.id);
  const result = await callSeats(`/trips/${id}`, {
    include_filtered: args.include_filtered,
  });
  return format(`Trip details for ${args.id}`, result);
}
