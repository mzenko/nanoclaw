import { z } from 'zod';

const CABIN_CLASSES = ['economy', 'premium', 'business', 'first'] as const;

// Regions documented at https://developers.seats.aero/reference/get-availability —
// the API rejects values outside this set with HTTP 400.
const REGIONS = [
  'North America',
  'South America',
  'Africa',
  'Asia',
  'Europe',
  'Oceania',
] as const;

const ORDER_BY_OPTIONS = ['lowest_mileage'] as const;

// `source` is a free string — seats.aero adds programs frequently and a hard-coded
// enum drifts. Canonical list from https://developers.seats.aero/reference/concepts-copy
// (as of 2026-04). The Concepts page also documents which cabins each program supports
// (Y/W/J/F = economy/premium/business/first) and notes that some programs (qatar,
// turkish, singapore) don't return taxes, while qantas/emirates/connectmiles/azul/
// american don't return seat counts. Unrecognized values surface as a 400 from the API.
const SOURCE_HINT =
  'Mileage program key. Canonical list: aeroplan, alaska, american, aeromexico, azul, ' +
  'connectmiles, delta, emirates, ethiopian, etihad, eurobonus, finnair, flyingblue, ' +
  'frontier, jetblue, lufthansa, qantas, qatar, saudia, singapore, smiles, spirit, ' +
  'turkish, united, velocity, virginatlantic.';

const dateRegex = /^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[01])$/;
const dateField = z.string().regex(dateRegex, 'YYYY-MM-DD');

// Accepts IATA airport codes OR seats.aero "multi-city codes" — mostly 3-letter
// (NYC, LON, USA, EUR, UAH) but at least one is 5-letter (INDIA), so allow 3-5.
const airportField = z
  .string()
  .regex(
    /^[A-Z]{3,5}(,[A-Z]{3,5})*$/,
    'IATA or multi-city code(s), comma-delimited if multiple, e.g. "JFK", "NYC", "USA", "INDIA"',
  );

// --- /search (Cached Search) --------------------------------------
//
// The endpoint accepts comma-delimited airports, multiple cabins, and a
// `sources` filter — the upstream MCP exposed none of these.
export const GetFlightsSchema = {
  originAirport: airportField.describe(
    'Origin IATA code or seats.aero multi-city code. Single ("JFK", "NYC", "USA"), ' +
      'or comma-delimited list ("JFK,EWR,BOS"). Multi-city codes expand server-side ' +
      '(e.g. NYC = JFK+LGA+EWR, LON = LHR+LGW+LCY+STN+LTN, USA = 13 major US airports, ' +
      'EUR = 24 major EU airports, UAH = United hubs, AAH = American hubs, DLL = Delta hubs). ' +
      'Use these for broad geographic searches in one call instead of paginating manually.',
  ),
  destinationAirport: airportField.describe(
    'Destination IATA code or multi-city code. Same expansion rules as originAirport ' +
      '(e.g. "NRT", "TYO" for Tokyo metro, "ASA" for major Asian airports).',
  ),
  startDate: dateField
    .optional()
    .describe('Range start (YYYY-MM-DD). For a single day, set startDate=endDate.'),
  endDate: dateField.optional().describe('Range end (YYYY-MM-DD).'),
  cabins: z
    .string()
    .optional()
    .describe(
      'Cabin filter, comma-delimited from {economy, premium, business, first}. ' +
        'Example: "business,first".',
    ),
  sources: z
    .string()
    .optional()
    .describe(
      'Restrict to specific mileage programs, comma-delimited (e.g. "aeroplan,united"). ' +
        SOURCE_HINT,
    ),
  carriers: z
    .string()
    .optional()
    .describe('2-char airline code(s), comma-delimited, e.g. "UA" or "DL,AA".'),
  only_direct_flights: z
    .boolean()
    .optional()
    .describe('Only return non-stop itineraries.'),
  include_trips: z
    .boolean()
    .optional()
    .describe(
      'Include trip-level summaries inline (FlightNumbers csv, Stops, MileageCost, ' +
        'TotalDuration, Carriers per trip). Does NOT include AvailabilitySegments — ' +
        'still need get_trips for segment-level data (per-leg times, aircraft, airports). ' +
        'Usually leave false; call get_trips for the few results you care about.',
    ),
  minify_trips: z
    .boolean()
    .optional()
    .describe(
      'Reduce trip payload size by ~56% (drops most metadata). Only meaningful with ' +
        'include_trips=true.',
    ),
  include_filtered: z
    .boolean()
    .optional()
    .describe(
      // Quoted from https://developers.seats.aero/reference/cached-search
      '"Return raw (unfiltered) results only." Default false (filtered set). ' +
        'Set true only if the user wants raw results that bypass dynamic-price filtering.',
    ),
  order_by: z
    .enum(ORDER_BY_OPTIONS)
    .optional()
    .describe(
      'Sort order. Only "lowest_mileage" supported. MCP defaults to it (overrides ' +
        'the API default of departure-date + cabin), since cheapest-first is what ' +
        'matches the typical "find me flights" intent.',
    ),
  take: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .optional()
    .describe(
      'Page size (10-1000). MCP defaults this to 1000 (the max) because each call ' +
        'counts as 1 against the daily quota regardless of response size, so taking fewer ' +
        'rows saves nothing. Lower only for broad searches where you only care about the ' +
        'top N cheapest — results are already sorted by lowest_mileage.',
    ),
  skip: z
    .number()
    .int()
    .optional()
    .describe('Number of results already retrieved across prior pages of this search.'),
  cursor: z
    .number()
    .int()
    .optional()
    .describe(
      'Pagination cursor — set to the `cursor` value from the FIRST response of this search ' +
        '(not the latest). Used together with skip for stable ordering across pages.',
    ),
};

// --- /availability (Bulk Availability) ----------------------------

export const GetBulkAvailSchema = {
  source: z.string().describe(SOURCE_HINT),
  cabin: z
    .enum(CABIN_CLASSES)
    .optional()
    .describe('Single cabin filter (this endpoint takes one cabin, not a list).'),
  startDate: dateField.optional(),
  endDate: dateField.optional(),
  originRegion: z.enum(REGIONS).optional(),
  destinationRegion: z.enum(REGIONS).optional(),
  include_filtered: z
    .boolean()
    .optional()
    .describe(
      // Quoted from https://developers.seats.aero/reference/get-availability
      '"Return raw (unfiltered) results only." Default false.',
    ),
  take: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .optional()
    .describe(
      'Page size (10-1000). MCP defaults this to 1000 (the max) because each call ' +
        'counts as 1 against the daily quota regardless of response size, so taking fewer ' +
        'rows saves nothing. Lower only for broad searches where you only care about the ' +
        'top N cheapest — results are already sorted by lowest_mileage.',
    ),
  skip: z
    .number()
    .int()
    .optional()
    .describe('Number of results already retrieved across prior pages of this search.'),
  cursor: z
    .number()
    .int()
    .optional()
    .describe('Cursor from the FIRST response of this search (not the latest).'),
};

// --- /routes ------------------------------------------------------

export const GetRoutesSchema = {
  source: z.string().describe(SOURCE_HINT),
};

// --- /trips/{id} (Get Trips) --------------------------------------
//
// Per the official Concepts doc:
//   "you call the Get Trips API with the ID of the Availability"
// — i.e. the top-level `ID` of a cached-search row, NOT an item from the
// row's AvailabilityTrips field. The response then contains all the
// individual trips (flight numbers, segments, times, aircraft) that
// belong to that summary Availability object.
export const GetTripsSchema = {
  id: z
    .string()
    .min(1)
    .describe(
      'The top-level "ID" field from a get_flights row (the Availability summary ID). ' +
        'Per https://developers.seats.aero/reference/concepts-copy, you pass the Availability ' +
        'ID — NOT individual trip IDs from the row\'s AvailabilityTrips field. The response ' +
        'will contain all trips for that Availability.',
    ),
  include_filtered: z
    .boolean()
    .optional()
    .describe(
      // Quoted from https://developers.seats.aero/reference/get-trips
      '"Include expensive dynamically-priced results that may have been filtered out." ' +
        'Default false.',
    ),
};
