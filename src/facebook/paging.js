// Following Facebook's "next page" cursor with plain web requests.
//
// A Marketplace search page carries its first 24 results and a cursor: a
// bookmark for where they end. When you scroll, Facebook's own page code asks
// /api/graphql/ for the next 24 with that cursor, gets a new cursor, and so on
// until Facebook says there are no more. This module does the same, with the
// session tokens the page carries for your cookies.
//
// The request needs the id of Facebook's "next page" query, which changes
// when Facebook updates its site. Three ways to get it, tried in order by the
// client: the id that worked last time, the id of the query the page itself
// ran (if it takes a cursor), or the id defined in the page's script files.

import { jsonScripts, extractFromJsonTexts, parseJsonStream } from './extract.js';

export const PAGING_QUERY = 'CometMarketplaceSearchContentPaginationQuery';
const TOKEN_MODULES = new Set(['DTSGInitialData', 'DTSGInitData', 'LSD', 'CurrentUserInitialData', 'SiteData']);
const MAX_DEPTH = 60;

/**
 * What a search page tells us about following its cursor:
 * tokens { dtsg, lsd, userId, name, rev }, the query the page ran
 * { docId, variables } (or null), the script files it loads, and where the
 * search is centered { lat, lon, radiusKm } (or null).
 */
export function readRecipe(html, base = 'https://www.facebook.com') {
  const text = String(html || '');
  const found = { tokens: { dtsg: '', lsd: '', userId: '', name: '', rev: '' }, queries: [], centers: [] };
  for (const doc of jsonScripts(text)) walk(doc, 0, found);
  const { tokens, queries, centers } = found;
  fallbackTokens(text, tokens);
  // The page's own search query: one that takes a cursor, preferably named for the Marketplace search.
  const query =
    queries.find((q) => /MarketplaceSearch/i.test(q.name) && 'cursor' in q.variables) ||
    queries.find((q) => 'cursor' in q.variables && (q.variables.params || q.variables.count)) ||
    null;
  // Where it searched: the search's own filter (with its distance) beats any other location on the page.
  const center = centers.find((c) => c.radiusKm) || centers[0] || null;
  return { tokens, query: query && { docId: query.docId, variables: query.variables }, scripts: scriptUrls(text, base), center };
}

function walk(node, depth, found) {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    // Facebook's module definitions: ["DTSGInitialData", [], { token: "…" }, 258]
    if (typeof node[0] === 'string' && TOKEN_MODULES.has(node[0]) && node[2] && typeof node[2] === 'object') takeTokens(node[0], node[2], found.tokens);
    for (const v of node) if (v && typeof v === 'object') walk(v, depth + 1, found);
    return;
  }
  const id = node.queryID ?? node.queryId ?? node.doc_id ?? node.docID;
  if ((typeof id === 'string' || typeof id === 'number') && /^\d{6,}$/.test(String(id)) && node.variables && typeof node.variables === 'object') {
    found.queries.push({ docId: String(id), variables: node.variables, name: String(node.preloaderID || node.queryName || node.name || '') });
  }
  // The search's location filter: { filter_location_latitude, filter_location_longitude, filter_radius_km }.
  const spot =
    point(node.filter_location_latitude, node.filter_location_longitude) ||
    (node.buyLocation && typeof node.buyLocation === 'object' ? point(node.buyLocation.latitude, node.buyLocation.longitude) : null);
  if (spot) {
    const km = Number(node.filter_radius_km);
    found.centers.push({ ...spot, radiusKm: km > 0 && km < 2000 ? km : null });
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') walk(v, depth + 1, found);
  }
}

/** A real place on the map, or null. */
function point(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  if (lat == null || lon == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: a, lon: b };
}

function takeTokens(name, data, tokens) {
  if ((name === 'DTSGInitialData' || name === 'DTSGInitData') && typeof data.token === 'string') tokens.dtsg ||= data.token;
  else if (name === 'LSD' && typeof data.token === 'string') tokens.lsd ||= data.token;
  else if (name === 'CurrentUserInitialData') {
    if (data.USER_ID && data.USER_ID !== '0') tokens.userId ||= String(data.USER_ID);
    if (typeof data.NAME === 'string') tokens.name ||= data.NAME;
  } else if (name === 'SiteData' && data.server_revision) tokens.rev ||= String(data.server_revision);
}

/** The same tokens, from other places they show up in a page. */
function fallbackTokens(text, tokens) {
  const grab = (re) => (text.match(re) || [])[1] || '';
  tokens.dtsg ||= grab(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || grab(/"dtsg":\{"token":"([^"]+)"/) || grab(/name="fb_dtsg" value="([^"]+)"/);
  tokens.lsd ||= grab(/"LSD",\[\],\{"token":"([^"]+)"/) || grab(/name="lsd" value="([^"]+)"/);
  tokens.userId ||= grab(/"USER_ID":"([1-9]\d*)"/) || grab(/"ACCOUNT_ID":"([1-9]\d*)"/);
  tokens.rev ||= grab(/"server_revision":(\d+)/) || grab(/"__spin_r":(\d+)/);
}

/** Script files the page loads (Facebook's code), as absolute URLs. */
function scriptUrls(text, base) {
  const out = new Set();
  for (const m of text.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"[^>]*>/gi)) {
    const tag = m[0];
    const src = m[1].replace(/&amp;/g, '&');
    if (!/\.js(\?|$)|rsrc\.php/.test(src)) continue;
    if (/^<link/i.test(tag) && !/\bas="script"/i.test(tag)) continue;
    try {
      out.add(new URL(src, base).toString());
    } catch {
      /* not a usable URL */
    }
  }
  return [...out];
}

/** Facebook's form checksum: "2" and the sum of the token's character codes. */
export const jazoest = (token) => `2${[...String(token)].reduce((sum, c) => sum + c.charCodeAt(0), 0)}`;

/** The form Facebook's page code posts to /api/graphql/ for the next page. */
export function pagingForm({ docId, variables, tokens, friendlyName = PAGING_QUERY, now = Date.now() }) {
  const f = new URLSearchParams();
  f.set('av', tokens.userId || '0');
  f.set('__user', tokens.userId || '0');
  f.set('__a', '1');
  f.set('__comet_req', '15');
  if (tokens.dtsg) f.set('fb_dtsg', tokens.dtsg);
  if (tokens.dtsg || tokens.lsd) f.set('jazoest', jazoest(tokens.dtsg || tokens.lsd));
  if (tokens.lsd) f.set('lsd', tokens.lsd);
  if (tokens.rev) {
    f.set('__rev', tokens.rev);
    f.set('__spin_r', tokens.rev);
    f.set('__spin_b', 'trunk');
    f.set('__spin_t', String(Math.floor(now / 1000)));
  }
  f.set('fb_api_caller_class', 'RelayModern');
  f.set('fb_api_req_friendly_name', friendlyName);
  f.set('variables', JSON.stringify(variables));
  f.set('server_timestamps', 'true');
  f.set('doc_id', docId);
  return f;
}

/** The page's own query variables, pointed at the next page. */
export function nextVariables(variables, cursor) {
  return { ...variables, cursor, ...('count' in variables ? { count: variables.count || 24 } : {}) };
}

/** The "next page" query's id, as one of Facebook's script files defines it. */
export function findQueryId(js, name = PAGING_QUERY) {
  const at = String(js).indexOf(`"${name}_facebookRelayOperation"`);
  if (at === -1) return null;
  const m = String(js)
    .slice(at, at + 400)
    .match(/exports\s*=\s*"(\d{6,})"/);
  return m ? m[1] : null;
}

/**
 * Reads an /api/graphql/ answer: { ok, listings, hasMore, cursor }, or
 * { ok: false, problem: 'login' | 'rate' | 'query' | 'other', message }.
 */
export function readPage(text, base) {
  const raw = String(text || '');
  const docs = parseJsonStream(raw);
  if (!docs.length) {
    const login = /<form[^>]+login|id="login_form"/i.test(raw);
    return { ok: false, problem: login ? 'login' : 'other', message: login ? 'Facebook answered with its login page' : 'Facebook sent something other than data' };
  }
  for (const d of docs) {
    // The classic error shape. 1357001 is "Not Logged In"; anything else, try another way.
    if (d && typeof d.error === 'number') {
      const login = d.error === 1357001 || /not logged in|log ?in to continue/i.test(`${d.errorSummary || ''} ${d.errorDescription || ''}`);
      return { ok: false, problem: login ? 'login' : 'other', message: String(d.errorSummary || `Facebook error ${d.error}`) };
    }
  }
  const got = extractFromJsonTexts([raw], { base });
  if (got.signals.rateLimited) return { ok: false, problem: 'rate', message: 'Facebook asked us to slow down' };
  if (got.signals.hasMore === null && !got.listings.length) {
    // The GraphQL error shape: an unknown query id or variables means "ask a different way".
    const messages = docs.flatMap((d) => (Array.isArray(d?.errors) ? d.errors : [])).map((e) => String(e.message || e.summary || ''));
    const message = messages.filter(Boolean).join('; ') || 'no search results in the answer';
    return { ok: false, problem: /persisted|document|doc_id|query|variable/i.test(message) ? 'query' : 'other', message };
  }
  return { ok: true, listings: got.listings, hasMore: got.signals.hasMore, cursor: got.signals.cursor };
}
