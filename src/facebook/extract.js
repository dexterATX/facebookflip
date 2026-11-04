// Pulls Marketplace listings out of whatever Facebook sends back.
//
// A Marketplace search page carries its first page of results as JSON inside
// <script type="application/json"> tags, and the browser engine also captures
// the GraphQL responses Facebook's own code fetches. Facebook moves that JSON
// around often, so instead of trusting one fixed path we walk every object and
// keep anything shaped like a listing (it has an id and a
// marketplace_listing_title). Duplicates are merged by id.

import { itemUrl } from './urls.js';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const JSON_TYPE_RE = /\btype\s*=\s*["']?application\/(?:ld\+)?json/i;
// Sponsored stories in the feed (e.g. "MarketplaceFeedAdStory"). Case-sensitive on purpose.
const AD_TYPENAME_RE = /AdStory|AdUnit|Sponsored/;
const MAX_DEPTH = 400;

// ---------------------------------------------------------------------------
// Entry points

export function extractFromHtml(html, { base } = {}) {
  const docs = [];
  for (const m of String(html).matchAll(SCRIPT_RE)) {
    if (!JSON_TYPE_RE.test(m[1])) continue;
    const body = m[2].trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
    try {
      docs.push(JSON.parse(body));
    } catch {
      /* not JSON after all */
    }
  }
  let result = collect(docs, base);
  if (!result.listings.length) {
    // Some page variants inline the payload in an ordinary script. Cut the
    // feed out of the raw text and try again.
    const extra = sliceFeedPayloads(String(html));
    if (extra.length) result = collect(docs.concat(extra), base);
  }
  result.signals = { ...result.signals, ...pageSignals(String(html)), jsonScripts: docs.length };
  return result;
}

/** GraphQL bodies may be prefixed with "for (;;);" and may hold several JSON documents, one per line. */
export function extractFromJsonTexts(texts, { base } = {}) {
  const docs = [];
  for (const t of texts) docs.push(...parseJsonStream(t));
  const result = collect(docs, base);
  result.signals.rateLimited = result.signals.rateLimited || texts.some((t) => /1675004/.test(t));
  return result;
}

export function parseJsonStream(text) {
  let t = String(text || '').trim();
  if (t.startsWith('for (;;);')) t = t.slice(9);
  if (!t) return [];
  try {
    return [JSON.parse(t)];
  } catch {
    /* fall through to line-by-line */
  }
  const out = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip partial line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Walking

function collect(docs, base) {
  const raws = [];
  const signals = { noResults: false, feed: false, rateLimited: false };
  for (const d of docs) walk(d, false, 0, raws, signals);
  const byId = new Map();
  for (const raw of raws) {
    const l = normalizeListing(raw, base);
    if (!l) continue;
    const prev = byId.get(l.id);
    byId.set(l.id, prev ? fillMissing(prev, l) : l);
  }
  return { listings: [...byId.values()], signals };
}

function walk(node, inAd, depth, out, signals) {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) if (v && typeof v === 'object') walk(v, inAd, depth + 1, out, signals);
    return;
  }
  const tn = node.__typename;
  if (typeof tn === 'string') {
    if (AD_TYPENAME_RE.test(tn)) inAd = true;
    else if (tn === 'MarketplaceSearchFeedNoResults') signals.noResults = true;
  }
  if ('feed_units' in node || 'marketplace_search' in node) signals.feed = true;
  if (Array.isArray(node.errors) && node.errors.some((e) => /1675004|rate limit/i.test(JSON.stringify(e)))) {
    signals.rateLimited = true;
  }
  if (!inAd && typeof node.marketplace_listing_title === 'string' && (typeof node.id === 'string' || typeof node.id === 'number')) {
    out.push(node);
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') walk(v, inAd, depth + 1, out, signals);
  }
}

/** Cut `"feed_units": {...}` objects straight out of raw page text. */
function sliceFeedPayloads(text) {
  const out = [];
  const re = /"(feed_units|marketplace_search)"\s*:\s*\{/g;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 30) {
    const start = m.index + m[0].length - 1;
    const json = balancedSlice(text, start);
    if (!json) continue;
    try {
      out.push({ [m[1]]: JSON.parse(json) });
    } catch {
      /* ignore */
    }
    re.lastIndex = start + json.length;
  }
  return out;
}

/** Returns the balanced {...} or [...] starting at `start`, aware of JSON strings. */
export function balancedSlice(text, start, maxLen = 8_000_000) {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inStr = false;
  const end = Math.min(text.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function pageSignals(html) {
  return {
    loginForm: /id=["']login_form["']|data-testid=["']royal_login_form["']|action=["'][^"']*\/login\/(?:device-based|\?)/i.test(html),
    rateLimited: /You(?:'|’|&#039;)re Temporarily Blocked|"code"\s*:\s*1675004/i.test(html),
  };
}

// ---------------------------------------------------------------------------
// Normalizing

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function toMillis(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  // Sanity window: after Marketplace launched and not in the future (allow some clock skew).
  if (ms < Date.UTC(2015, 0, 1) || ms > Date.now() + 36 * 3600e3) return null;
  return Math.round(ms);
}

/** "$1,234.50" -> 1234.5, "Free" -> 0, "1.234,50 €" -> 1234.5 */
export function parsePriceText(text) {
  const s = clean(text);
  if (!s) return null;
  if (/^(free|gratis|gratuit|kostenlos|gratuito)$/i.test(s)) return 0;
  let digits = s.replace(/[^\d.,]/g, '');
  if (!digits || !/\d/.test(digits)) return null;
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    digits = digits.split(thou).join('').replace(dec, '.');
  } else if (lastComma !== -1) {
    digits = /,\d{2}$/.test(digits) && digits.indexOf(',') === lastComma ? digits.replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastDot !== -1 && !/\.\d{1,2}$/.test(digits)) {
    digits = digits.replace(/\./g, ''); // "1.234" thousands separator
  }
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_SYMBOLS = { $: 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY', '₱': 'PHP', R$: 'BRL', A$: 'AUD', C$: 'CAD' };
function currencyFromText(t) {
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS).sort((a, b) => b[0].length - a[0].length)) {
    if (t.includes(sym)) return code;
  }
  return null;
}

export function normalizeListing(raw, base = 'https://www.facebook.com') {
  const id = String(raw.id ?? '').trim();
  if (!/^\d{5,25}$/.test(id)) return null;
  const title = clean(raw.marketplace_listing_title || raw.custom_title || raw.base_marketplace_listing_title);

  const lp = raw.listing_price || null;
  const priceText = clean(lp?.formatted_amount_zeros_stripped || lp?.formatted_amount || raw.formatted_price?.text);
  let price = parseAmount(lp?.amount);
  if (price === null && lp?.amount_with_offset_in_currency != null) {
    const v = parseAmount(lp.amount_with_offset_in_currency);
    price = v === null ? null : v / 100;
  }
  if (price === null) price = parsePriceText(priceText);

  const sp = raw.strikethrough_price || null;
  const wasPriceText = clean(sp?.formatted_amount) || null;
  let wasPrice = parseAmount(sp?.amount);
  if (wasPrice === null && wasPriceText) wasPrice = parsePriceText(wasPriceText);

  const rg = raw.location?.reverse_geocode || {};
  const city = clean(rg.city) || null;
  const state = clean(rg.state) || null;
  const locationText =
    clean(rg.city_page?.display_name) || [city, state].filter(Boolean).join(', ') || clean(raw.location_text?.text) || null;

  const photo =
    raw.primary_listing_photo?.image?.uri ||
    raw.primary_listing_photo?.listing_image?.uri ||
    raw.primary_photo?.image?.uri ||
    raw.listing_photos?.[0]?.image?.uri ||
    null;

  const upper = title.toUpperCase();
  return {
    id,
    title: title || 'Untitled listing',
    price,
    priceText: priceText || (price === 0 ? 'Free' : price != null ? `$${price}` : ''),
    currency: lp?.currency || currencyFromText(priceText) || null,
    wasPrice: wasPrice !== null && price !== null && wasPrice > price ? wasPrice : null,
    wasPriceText: wasPrice !== null && price !== null && wasPrice > price ? wasPriceText : null,
    photo: typeof photo === 'string' ? photo : null,
    city,
    state,
    locationText,
    creationTime: toMillis(raw.creation_time ?? raw.listing_time ?? raw.created_time),
    sold: raw.is_sold === true || upper.startsWith('[SOLD]') || upper.startsWith('SOLD -') || upper === 'SOLD',
    pending: raw.is_pending === true,
    live: raw.is_live !== false,
    hiddenOnFb: raw.is_hidden === true,
    deliveryTypes: Array.isArray(raw.delivery_types) ? raw.delivery_types.filter((x) => typeof x === 'string').slice(0, 6) : [],
    categoryId: raw.marketplace_listing_category_id ? String(raw.marketplace_listing_category_id) : null,
    seller: clean(raw.marketplace_listing_seller?.name) || null,
    url: itemUrl(id, base),
  };
}

function fillMissing(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (cur === null || cur === undefined || cur === '' || (Array.isArray(cur) && !cur.length)) out[k] = v;
  }
  if (out.title === 'Untitled listing' && b.title !== 'Untitled listing') out.title = b.title;
  return out;
}

export function mergeListings(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const l of list) byId.set(l.id, byId.has(l.id) ? fillMissing(byId.get(l.id), l) : l);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Last-resort: read the visible cards (browser engine only).

const PRICE_LINE_RE = /^(free|[^\d\s]{0,3}\s?\d[\d.,]*\s?[^\d\s]{0,3})$/i;

export function normalizeDomCard(card, base = 'https://www.facebook.com') {
  const m = String(card.href || '').match(/\/marketplace\/item\/(\d{5,25})/);
  if (!m) return null;
  const lines = String(card.text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const prices = [];
  let i = 0;
  while (i < lines.length && PRICE_LINE_RE.test(lines[i]) && prices.length < 2) prices.push(lines[i++]);
  const title = lines[i++] || '';
  const loc = lines[i] && !/miles? away|km away/i.test(lines[i]) ? lines[i] : '';
  const price = prices.length ? parsePriceText(prices[0]) : null;
  const was = prices[1] ? parsePriceText(prices[1]) : null;
  return {
    id: m[1],
    title: title || 'Untitled listing',
    price,
    priceText: prices[0] || '',
    currency: currencyFromText(prices[0] || ''),
    wasPrice: was !== null && price !== null && was > price ? was : null,
    wasPriceText: was !== null && price !== null && was > price ? prices[1] : null,
    photo: /^https?:\/\//.test(card.img || '') ? card.img : null,
    city: null,
    state: null,
    locationText: loc || null,
    creationTime: null,
    sold: /^sold\b/i.test(title),
    pending: false,
    live: true,
    hiddenOnFb: false,
    deliveryTypes: [],
    categoryId: null,
    seller: null,
    url: itemUrl(m[1], base),
  };
}

// ---------------------------------------------------------------------------
// A single listing's page: description, condition, sold state, photos.

const CONDITION_NAMES = {
  new: 'New',
  used: 'Used',
  used_like_new: 'Used - like new',
  used_good: 'Used - good',
  used_fair: 'Used - fair',
  used_poor: 'Used - poor',
  refurbished: 'Refurbished',
};

export function conditionName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.replace(/^PC_/i, '').toLowerCase().trim();
  return CONDITION_NAMES[key] || raw.replace(/^PC_/i, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function textOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string') return v.text;
  return null;
}

/** Pulls description/condition for listing `id` out of an item page (and any captured GraphQL). */
export function extractItemDetails(html, id, extraJson = []) {
  const docs = [];
  for (const m of String(html || '').matchAll(SCRIPT_RE)) {
    if (!JSON_TYPE_RE.test(m[1])) continue;
    const body = m[2].trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
    try {
      docs.push(JSON.parse(body));
    } catch {
      /* not JSON */
    }
  }
  for (const t of extraJson) docs.push(...parseJsonStream(t));

  const found = { description: null, condition: null, sold: false, pending: false, photos: [] };
  let matched = false;
  const visit = (node, depth) => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    if (String(node.id ?? '') === String(id)) {
      matched = true;
      found.description ||= textOf(node.redacted_description) || textOf(node.description) || null;
      found.condition ||= conditionName(node.condition || node.marketplace_listing_condition || null);
      if (node.is_sold === true) found.sold = true;
      if (node.is_pending === true) found.pending = true;
      if (Array.isArray(node.listing_photos) && !found.photos.length) {
        found.photos = node.listing_photos.map((p) => p?.image?.uri).filter((u) => typeof u === 'string').slice(0, 6);
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  for (const d of docs) visit(d, 0);

  if (!found.description) {
    // Fallback: the page's own summary tag.
    const m = String(html || '').match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']*)["']/i);
    if (m) {
      found.description = m[1].replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      matched = true;
    }
  }
  if (found.description) {
    // Keep line breaks: they separate sentences for the red-flag checks.
    found.description = found.description.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 3000);
  }
  return matched ? found : null;
}
