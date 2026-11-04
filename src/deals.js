// Text helpers and the user's own filters (price range, include/skip words).

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

/** Lowercase, strip accents and punctuation, pad with spaces: " trek fx 2 bike ". */
export const norm = (s) =>
  ` ${String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}$]+/gu, ' ')
    .trim()} `;

// `text` must already be normalized with norm().
function includesTerm(text, term) {
  const t = norm(term).trim();
  return Boolean(t) && text.includes(` ${t}`);
}

/** Matches whole words, or the start of a word ("broke" matches "broken"). Accents and case are ignored. */
export const hasTerm = (text, term) => includesTerm(norm(text), term);

/**
 * Why a listing fails the watch's own filters, or null if it passes.
 * (Listings that fail are kept in the Unsorted pile with this reason.)
 */
export function filterReason(listing, watch, settings = {}) {
  const p = listing.price;
  if (p !== null && p !== undefined) {
    if (watch.minPrice != null && p < watch.minPrice) return `Under your minimum price ($${watch.minPrice})`;
    if (watch.maxPrice != null && p > watch.maxPrice) return `Over your maximum price ($${watch.maxPrice})`;
    // "$1" listings are almost always bait ("message me for price").
    if (settings.hidePlaceholderPrices && p > 0 && p <= 1) return '"$1" placeholder price';
  }
  const text = norm(listing.title);
  const skip = watch.exclude?.find((t) => includesTerm(text, t));
  if (skip) return `Has your skip word "${skip}"`;
  if (watch.include?.length && !watch.include.some((t) => includesTerm(text, t))) {
    return `Missing your must-have words (${watch.include.slice(0, 3).join(', ')})`;
  }
  return null;
}

export const passesFilters = (listing, watch, settings) => !filterReason(listing, watch, settings);

const STOP = new Set(
  ('a an and are as at be by for from in is it of on or the to with this that new used like great good nice excellent ' +
    'condition cond shape works working perfect perfectly barely brand obo firm price cash pickup pick up local only must ' +
    'go sale selling sell asking great deal clean mint smoke free home pet very gently lightly comes includes included')
    .split(' '),
);

/** Meaningful words of a title: "PS5 Disc Edition + 2 controllers" -> ps5, disc, edition, controller */
export function titleWords(title) {
  const out = new Set();
  for (const w of norm(title).trim().split(' ')) {
    if (w.length < 2 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    out.add(w.replace(/(?<=[a-z]{3})s$/, '')); // crude plural folding: "controllers" -> "controller"
  }
  return out;
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
