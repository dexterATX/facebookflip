// The built-in price guide: typical USED selling prices for popular flip
// items, with where each number came from and when (src/data/price-guide.json).
//
// matchGuide(title) finds the guide entry a listing is for, or null. It is
// deliberately strict: a wrong match is worse than no match, because no match
// just means "price it from similar listings instead". So it skips:
//   - accessories and parts ("PS5 controller", "case for iPhone 15"),
//   - titles that name two different items ("PS4 and PS5"),
//   - models the guide doesn't have ("iPhone 13 mini", "iPhone 16e").

import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('./data/price-guide.json', import.meta.url), 'utf8'));

export const GUIDE_AS_OF = DATA.asOf;
const AS_OF_MS = Date.parse(`${DATA.asOf}T12:00:00Z`);

// Words that join the main item to extras: "PS5 with 2 controllers".
const CONNECTORS = new Set(['with', 'plus', 'and', 'bundle', 'bundled', 'includes', 'including', 'included', 'incl', 'comes']);
const NEGATORS = new Set(['no', 'without', 'missing', 'minus', 'except', 'excluding']);
// "Switch 2 controllers" is two controllers, not a Switch 2.
const COUNT_NOUNS = new Set(['controllers', 'games', 'joycons', 'joy', 'remotes', 'cases', 'chargers', 'cables', 'headsets', 'docks', 'cartridges', 'carts', 'discs', 'cards', 'straps', 'skins', 'accessories', 'pieces', 'items', 'pcs', 'pack', 'packs']);
// "Case for iPhone 15", "VR2 for PS5": made for the device, not the device.
const DEVICE_WORDS = ['iphone', 'ipad', 'ps5', 'ps4', 'ps 5', 'ps 4', 'playstation', 'xbox', 'switch', 'nintendo', 'steam deck', 'steamdeck', 'quest', 'oculus', 'meta quest', 'airpods', 'galaxy', 'samsung', 's24'];
// "Video game console" is the console.
const DEVICE_NOUNS = new Set(['console', 'consoles', 'system']);
// "Tablet only", "headset only": the main unit without what normally comes with it.
const BARE_UNIT = ['console only', 'tablet only', 'headset only', 'system only', 'unit only'];
// Group terms of one entry ("ps5" ... "slim" ... "digital") must sit this close together.
const MAX_SPAN = 6;

/** Lowercase word tokens; "|" marks punctuation breaks that phrases can't cross. */
export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\bw\s*\/\s*o\b/g, ' without ')
    .replace(/\bw\s*\/\s*/g, ' with ')
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/(?<!\d)[.,](?!\d)|[;:!?()[\]{}|•·]|\s[-–—]+\s/g, ' | ')
    .replace(/\b(iphone|ipad|galaxy|quest|switch|deck|series)(?=\d)/g, '$1 ')
    .replace(/\bseries([xs])\b/g, 'series $1')
    .replace(/[^a-z0-9|]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

const phrase = (p) => tokens(p).filter((t) => t !== '|');
const compileWords = (list = []) => list.map(phrase).filter((p) => p.length);

function at(toks, i, p) {
  for (let k = 0; k < p.length; k++) if (toks[i + k] !== p[k]) return false;
  return true;
}

/** Every position where phrase `p` starts. */
function positions(toks, p) {
  const out = [];
  for (let i = 0; i + p.length <= toks.length; i++) if (at(toks, i, p)) out.push(i);
  return out;
}

/** Positions of a model name used as the item itself, not as a count ("switch 2 controllers"). */
function termPositions(toks, p) {
  const numeric = /^\d+$/.test(p[p.length - 1]);
  return positions(toks, p).filter((i) => !(numeric && COUNT_NOUNS.has(toks[i + p.length])));
}

/** "no disc drive", "without the dock": a negator up to 3 words back, in the same phrase. */
function negatedAt(toks, i) {
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
    if (toks[k] === '|' || CONNECTORS.has(toks[k])) return false;
    if (NEGATORS.has(toks[k])) return true;
  }
  return false;
}

const byCategory = (obj) =>
  Object.fromEntries(
    Object.entries(obj || {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => [k, compileWords(v)]),
  );
const ACCESSORY = byCategory(DATA.accessoryWords);
const INCLUDED = byCategory(DATA.usuallyIncluded);
const DEVICES = compileWords(DEVICE_WORDS);
const BARE = compileWords(BARE_UNIT);

const ITEMS = DATA.items.map((e) => ({
  ...e,
  allP: e.all.map(compileWords),
  noneP: compileWords(e.none),
  variantsP: (e.variants || []).map((v) => ({ ...v, anyP: compileWords(v.any) })),
}));

/** Every group of terms is present, close together. */
function groupsMatch(toks, groups) {
  const spans = groups.map((g) => g.flatMap((p) => termPositions(toks, p).map((i) => [i, i + p.length - 1])));
  if (spans.some((list) => !list.length)) return false;
  return spans[0].some(([s0, e0]) => spans.slice(1).every((list) => list.some(([s, e]) => Math.max(e, e0) - Math.min(s, s0) <= MAX_SPAN)));
}

/**
 * The accessory word that makes this title an accessory rather than the
 * device, or null. Words after "with"/"+"/"and"/"bundle", after a count
 * ("2 controllers"), after "no"/"without", or before "console" don't count.
 */
export function accessoryWord(title, category) {
  const toks = Array.isArray(title) ? title : tokens(title);
  for (const d of DEVICES) {
    if (positions(toks, d).some((i) => toks[i - 1] === 'for')) return `for ${d.join(' ')}`;
  }
  const firstConnector = toks.findIndex((t) => CONNECTORS.has(t));
  const words = [...(ACCESSORY.all || []), ...(ACCESSORY[category] || [])];
  for (const w of words) {
    for (const i of positions(toks, w)) {
      if (firstConnector !== -1 && i > firstConnector) continue;
      if (/^\d{1,2}$/.test(toks[i - 1] || '') || negatedAt(toks, i)) continue;
      if (DEVICE_NOUNS.has(toks[i + w.length])) continue;
      return w.join(' ');
    }
  }
  return null;
}

// "No controller drift" is about the controller's condition, not a missing controller.
const ABOUT_CONDITION = new Set(['drift', 'drifting', 'issue', 'issues', 'problem', 'problems', 'damage', 'scratches', 'scratch', 'marks']);

/** What the title says is missing from a normally complete item ("no controller", "tablet only"), or null. */
export function missingPart(title, category) {
  const toks = Array.isArray(title) ? title : tokens(title);
  for (const w of INCLUDED[category] || []) {
    if (positions(toks, w).some((i) => negatedAt(toks, i) && !ABOUT_CONDITION.has(toks[i + w.length]))) return `no ${w.join(' ')}`;
  }
  if (INCLUDED[category]) {
    const bare = BARE.find((p) => positions(toks, p).length);
    if (bare) return bare.join(' ');
  }
  return null;
}

/** Days since the guide's prices were collected. */
export const guideAgeDays = (now = Date.now()) => Math.max(0, Math.floor((now - AS_OF_MS) / 86400e3));

/**
 * The price guide entry for a listing title, or null.
 * Returns { id, name, size, label, price, category, source, sourceName, basis, url, asOf, ageDays, volatile, note, missing }.
 */
export function matchGuide(title, { now = Date.now() } = {}) {
  const toks = tokens(title);
  if (!toks.length) return null;
  const accessory = {};
  const hits = [];
  for (const e of ITEMS) {
    if (e.noneP.some((p) => positions(toks, p).length)) continue;
    if (!groupsMatch(toks, e.allP)) continue;
    if (!(e.category in accessory)) accessory[e.category] = accessoryWord(toks, e.category);
    if (accessory[e.category]) continue;
    hits.push(e);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.allP.length - a.allP.length);
  // Two equally specific matches ("PS4 and PS5", "iPhone 13 or 14"): don't guess.
  if (hits.length > 1 && hits[1].allP.length === hits[0].allP.length) return null;
  const e = hits[0];

  // Storage or version, named before any extras ("with 512GB SD card" is an extra).
  const firstConnector = toks.findIndex((t) => CONNECTORS.has(t));
  const head = firstConnector === -1 ? toks : toks.slice(0, firstConnector);
  const v = e.variantsP.find((x) => x.anyP.some((p) => positions(head, p).length));
  const size = v ? v.size : e.size || null;
  const src = DATA.sources[e.source] || { name: e.source, basis: '' };
  return {
    id: e.id,
    name: e.name,
    size,
    label: size ? `${e.name}, ${size}` : e.name,
    price: v ? v.price : e.price,
    category: e.category,
    source: e.source,
    sourceName: src.name,
    basis: src.basis,
    url: e.url,
    asOf: DATA.asOf,
    ageDays: guideAgeDays(now),
    volatile: Boolean(e.volatile),
    note: e.note || null,
    missing: missingPart(toks, e.category),
  };
}

/** The whole guide, for the Settings screen. */
export function guideSummary() {
  return {
    asOf: DATA.asOf,
    sources: Object.values(DATA.sources).map((s) => ({ name: s.name, basis: s.basis, url: s.url })),
    items: DATA.items.map((e) => ({
      name: e.name,
      size: e.size || null,
      price: e.price,
      category: e.category,
      source: DATA.sources[e.source]?.name || e.source,
      url: e.url,
      variants: (e.variants || []).map((v) => ({ size: v.size, price: v.price })),
      volatile: Boolean(e.volatile),
    })),
  };
}
