// The "smart" part: keyword filters, junk-price filtering and deal scoring.

import { median } from './util.js';

/** Words that usually mean "not what you want" on Marketplace. Offered as a one-click add. */
export const JUNK_WORDS = [
  'broken',
  'for parts',
  'parts only',
  'not working',
  'cracked',
  'iso',
  'in search of',
  'looking for',
  'wanted',
  'box only',
  'case only',
  'read description',
];

const norm = (s) =>
  ` ${String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}$]+/gu, ' ')
    .trim()} `;

// `text` must already be normalized with norm().
function includesTerm(text, term) {
  const t = norm(term).trim();
  return Boolean(t) && text.includes(` ${t}`);
}

/** Matches whole words, or the start of a word ("broke" matches "broken"). Accents and case are ignored. */
export const hasTerm = (text, term) => includesTerm(norm(text), term);

export function passesFilters(listing, watch, settings = {}) {
  const p = listing.price;
  if (p !== null && p !== undefined) {
    if (watch.minPrice != null && p < watch.minPrice) return false;
    if (watch.maxPrice != null && p > watch.maxPrice) return false;
    // "$1" listings are almost always bait ("message me for price").
    if (settings.hidePlaceholderPrices && p > 0 && p <= 1) return false;
  }
  const text = norm(listing.title);
  if (watch.exclude?.length && watch.exclude.some((t) => includesTerm(text, t))) return false;
  if (watch.include?.length && !watch.include.some((t) => includesTerm(text, t))) return false;
  return true;
}

export const DEAL_LABELS = ['steal', 'great', 'good'];

const STOP = new Set(
  ('a an and are as at be by for from in is it of on or the to with this that new used like great good nice excellent ' +
    'condition cond shape works working perfect perfectly barely brand obo firm price cash pickup pick up local only must ' +
    'go sale selling sell asking great deal clean mint smoke free home pet very gently lightly comes includes included')
    .split(' '),
);

/** Meaningful words of a title: "PS5 Disc Edition + 2 controllers" -> ps5, disc, edition, controllers */
export function titleWords(title) {
  const out = new Set();
  for (const w of norm(title).trim().split(' ')) {
    if (w.length < 2 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    out.add(w.replace(/(?<=[a-z]{3})s$/, '')); // crude plural folding: "controllers" -> "controller"
  }
  return out;
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

/**
 * How does this price compare with what similar listings went for?
 *
 * "Similar" means listings from the same watch whose titles share words beyond
 * the search words themselves, so a $40 PS5 controller is compared with other
 * controllers, not with $400 consoles. With too few similar listings we only
 * fall back to the whole watch when its prices are tightly grouped; otherwise
 * we say nothing rather than guess.
 */
export function dealScore(listing, pool, searchWords = []) {
  const price = listing?.price;
  if (price === null || price === undefined || price <= 1) return null;
  const skip = new Set(searchWords.flatMap((w) => [...titleWords(w)]));
  const minus = (set) => new Set([...set].filter((w) => !skip.has(w)));
  const mine = minus(titleWords(listing.title));
  const others = pool.filter((o) => o.id !== listing.id && o.price > 1);

  let basis = null;
  if (mine.size) {
    const comps = others.filter((o) => {
      const theirs = minus(titleWords(o.title));
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      // Two words in common, or at least half of this (short) title's words.
      return shared >= 2 || (shared >= 1 && shared / mine.size >= 0.5);
    });
    if (comps.length >= 4) basis = comps.map((o) => o.price);
  }
  if (!basis && others.length >= 8) {
    const xs = others.map((o) => o.price).sort((a, b) => a - b);
    const med = median(xs);
    if (med && (quantile(xs, 0.75) - quantile(xs, 0.25)) / med <= 0.5) basis = xs;
  }
  if (!basis) return null;

  const med = median(basis);
  if (!med) return null;
  const pct = (med - price) / med;
  let label = 'fair';
  if (pct >= 0.4) label = 'steal';
  else if (pct >= 0.25) label = 'great';
  else if (pct >= 0.12) label = 'good';
  else if (pct <= -0.3) label = 'high';
  return { label, pct: Math.round(pct * 100), median: Math.round(med), n: basis.length };
}

export const isDeal = (l) => Boolean(l.deal && DEAL_LABELS.includes(l.deal.label));
