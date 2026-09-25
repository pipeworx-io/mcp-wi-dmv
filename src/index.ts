interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * Wisconsin DMV MCP — every WisDOT DMV customer service center, with the services each
 * individual center actually performs. Keyless.
 *
 * One pack per state agency: Wisconsin's grain is a per-station capability matrix (does this
 * counter issue commercial plates? does it give the written knowledge test in a language other
 * than English? does it take cash?), which has nothing in common with California's ZIP-level
 * registration snapshot or Tennessee's driver-service-center layer. A union schema across
 * states would leave most arguments ignored, so Wisconsin gets its own tool with its own
 * arguments.
 *
 * Source (verified live 2026-07-29):
 *   dotmaps.wi.gov ArcGIS agohub/DMV_SERVICE_CENTER/MapServer/0 — 88 service centers with
 *   address, county, per-day hours, LAT/LON attribute columns, accessibility, accepted
 *   payment methods, and 16 "Y"/"N" service-capability flags. WisDOT opens and closes rural
 *   counters, so the statewide count moves; responses report the live figure rather than a
 *   number baked in here.
 *
 * WisDOT's ArcGIS host is intermittently slow — it overran a 12s budget on a production call
 * and answered in ~1s on the retry — so the query runs on the shared helper's 15s budget plus
 * one retry, and a genuine stall comes back as { error, hint } telling the caller to retry
 * rather than as an empty office list.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-wi-dmv/1.0 (+https://pipeworx.io)';
const LAYER = 'https://dotmaps.wi.gov/arcgis/rest/services/agohub/DMV_SERVICE_CENTER/MapServer/0';

/**
 * Service-capability flags, in the order a caller is likely to ask about them.
 * DRV_KNLG_TEST_VAR_LANG_FL is the distinctive one: Wisconsin is the only state DMV layer
 * that publishes, per counter, whether the written knowledge test is offered in languages
 * beyond English.
 */
const SERVICE_FLAGS: Record<string, string> = {
  DRV_DL_FL: 'driver license',
  DRV_IDCARD_FL: 'ID card',
  DRV_KNLG_TEST_FL: 'knowledge test',
  DRV_KNLG_TEST_VAR_LANG_FL: 'knowledge test in multiple languages',
  DRV_DISA_PRKG_FL: 'disabled parking permit',
  VEH_PRDT_DSPL_TITL_FL: 'vehicle title',
  VEH_PRDT_DSPL_LIC_PLT_FL: 'license plates',
  VEH_PRDT_DSPL_RNWL_STKR_FL: 'registration renewal stickers',
  VEH_PRDT_DSPL_MCYC_FL: 'motorcycle plates',
  VEH_PRDT_DSPL_RV_TRLR_FL: 'RV and trailer plates',
  VEH_PRDT_DSPL_FARM_FL: 'farm vehicle plates',
  VEH_PRDT_DSPL_CMRL_FL: 'commercial vehicle plates',
  VEH_PRDT_DSPL_DISA_PRKG_FL: 'disabled parking plates',
};

const PAYMENT_FLAGS: Record<string, string> = {
  ACPL_CASH_PYMT_FL: 'cash',
  ACPL_CHECK_PYMT_FL: 'check',
  ACPL_CR_PYMT_FL: 'credit or debit card',
};

const SERVICE_LABELS = Object.values(SERVICE_FLAGS);

interface Station {
  state: string;
  name: string;
  office_type: string;
  station_id: string | null;
  address: string | null;
  address_note: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  phone: string | null;
  hours: string | null;
  latitude: number | null;
  longitude: number | null;
  services: string[];
  payment_methods: string[];
  wheelchair_accessible: boolean;
  services_excluded: string | null;
  special_rules: string | null;
  url: string | null;
}

/** Collapse the CRLF-padded free-text columns WisDOT ships into one readable line. */
function tidy(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

async function loadStations(): Promise<Station[]> {
  // LAT/LON are real attribute columns on this layer, so no geometry round-trip is needed.
  const feats = await arcgisQuery(LAYER, { limit: 500, userAgent: UA });
  return feats.map(({ attributes: a }) => ({
    state: 'WI',
    name: String(a.STN_NAME ?? a.STN_DESC ?? '').trim(),
    office_type: 'DMV customer service center',
    station_id: a.STN_ID ? String(a.STN_ID) : null,
    address: [a.STN_ADDR_LINE, a.STN_ADDR_ADDL_L2].filter(Boolean).join(', ') || null,
    address_note: tidy(a.STN_ADDR_REF),
    city: (a.STN_CITY as string) ?? null,
    county: (a.STN_CNTY as string) ?? null,
    zip: a.STN_ZPCD ? String(a.STN_ZPCD) : null,
    // WisDOT routes every centre through one statewide number rather than publishing
    // per-station phones, so the column does not exist upstream.
    phone: null,
    hours: govJoinHours([
      ['Mon', a.STN_HRS_MON], ['Tue', a.STN_HRS_TUE], ['Wed', a.STN_HRS_WED],
      ['Thu', a.STN_HRS_THUR], ['Fri', a.STN_HRS_FRI], ['Sat', a.STN_HRS_SAT],
      ['Sun', a.STN_HRS_SUN],
    ]),
    latitude: govNumber(a.LAT),
    longitude: govNumber(a.LON),
    services: arcgisFlagLabels(a, SERVICE_FLAGS),
    payment_methods: arcgisFlagLabels(a, PAYMENT_FLAGS),
    wheelchair_accessible: /^(y|yes|true)$/i.test(String(a.STN_DISA_ACS ?? '')),
    services_excluded: tidy(a.STN_EXLD_PRDT_DSPL),
    special_rules: tidy(a.STN_SPCL_RULES),
    url: null,
  }));
}

const tools: McpToolExport['tools'] = [
  {
    name: 'wi_dmv_offices',
    description:
      'Find Wisconsin DMV customer service centers (WisDOT) with street address, county, per-day opening hours, coordinates, wheelchair accessibility, accepted payment methods, and exactly which services each of the 88 centers performs. Wisconsin publishes a per-counter capability matrix, so this answers questions an address list cannot: "which Wisconsin DMV gives the written knowledge test in Spanish or another language", "which DMV near Milwaukee issues commercial vehicle plates", "which Wisconsin DMV takes cash", "which service center does farm truck plates or motorcycle plates", plus the plain "DMV office in Madison" or "DMV in Dane County". Filter by city, county, ZIP, station name, or a required service; call with no arguments for every center statewide.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Madison", "Green Bay".' },
        county: { type: 'string', description: 'Wisconsin county name, matched as a substring, e.g. "Dane", "Milwaukee".' },
        zip: { type: 'string', description: 'Five-digit Wisconsin ZIP code, or a prefix, e.g. "53703".' },
        name: { type: 'string', description: 'Service-center name substring, e.g. "Alma", "Odana".' },
        service: {
          type: 'string',
          description:
            `Require a service or payment method, matched as a substring. Published services: ${SERVICE_LABELS.join(', ')}. Payment methods: ${Object.values(PAYMENT_FLAGS).join(', ')}. Use "knowledge test in multiple languages" for centers that give the written test in a language other than English.`,
        },
        limit: { type: ['number', 'string'], description: 'Max centers to return (default 50, max 200).' },
      },
    },
  },
];

async function offices(args: Record<string, unknown>): Promise<unknown> {
  let list = await loadStations();
  const statewide = list.length;
  if (!list.length) {
    return govNotFound(
      'upstream_empty',
      'WisDOT returned no service centers. Retry once — its ArcGIS host stalls intermittently and answers normally on the next call.',
    );
  }
  const city = govString(args, 'city');
  if (city) list = list.filter((o) => govContains(o.city, city));
  const county = govString(args, 'county');
  if (county) list = list.filter((o) => govContains(o.county, county));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => (o.zip ?? '').startsWith(zip));
  const name = govString(args, 'name');
  if (name) list = list.filter((o) => govContains(o.name, name));
  const service = govString(args, 'service');
  if (service) {
    list = list.filter(
      (o) =>
        o.services.some((s) => govContains(s, service)) ||
        o.payment_methods.some((p) => govContains(p, service)),
    );
  }
  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No Wisconsin DMV service center matched those filters. Drop the narrowest one — \`service\` and \`city\` are the usual culprits, and a ZIP is matched as a prefix so it must be the center's own ZIP — or call with no arguments for all ${statewide} centers statewide. Wisconsin publishes these service labels: ${SERVICE_LABELS.join(', ')}.`,
      { filters_applied: { city, county, zip, name, service }, available_services: SERVICE_LABELS, statewide_office_count: statewide },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'WI',
    source: 'WisDOT ArcGIS agohub/DMV_SERVICE_CENTER — Wisconsin DMV customer service centers',
    office_count: list.length,
    statewide_office_count: statewide,
    truncated: list.length > limit,
    offices: list.slice(0, limit),
    note: 'Hours list only the days a center is open; a day absent from `hours` is closed. `services_excluded` names transactions that specific center sends elsewhere.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'wi_dmv_offices': return await offices(args);
      default:
        return govNotFound('unknown_tool', `wi-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `wi-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'WisDOT\'s ArcGIS host stalls intermittently and usually answers in about a second on the next attempt. Retry the identical call once.'
        : 'dotmaps.wi.gov refused the request or changed shape. Retry once; if it persists the DMV_SERVICE_CENTER layer may have been republished at a new path.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
