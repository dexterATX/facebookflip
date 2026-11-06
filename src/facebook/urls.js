// Builds and reads Facebook Marketplace links.
//
// Every search we run is forced to "Date listed: newest first" and
// "listed in the last 24 hours" so the newest posts are always on page one.

import { toNumber } from '../util.js';
import { milesToKm } from '../area.js';

export const SORT_NEWEST = 'creation_time_descend';
const MANAGED = new Set(['query', 'minPrice', 'maxPrice', 'radius', 'sortBy', 'daysSinceListed', 'exact']);

/** "San Francisco" -> "sanfrancisco". Numeric Facebook place ids pass through. */
export function cleanLocation(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return s;
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '');
}

/**
 * The Marketplace search link for a watch. `area` (Settings > Your area) fills
 * in the place and distance when the watch doesn't set its own, and asks
 * Facebook for local pickup only.
 */
export function buildSearchUrl(watch, base = 'https://www.facebook.com', area = null) {
  const params = new URLSearchParams();
  const query = String(watch.query || '').trim();
  if (query) params.set('query', query);
  if (watch.minPrice != null) params.set('minPrice', String(Math.max(0, Math.floor(watch.minPrice))));
  if (watch.maxPrice != null) params.set('maxPrice', String(Math.max(0, Math.ceil(watch.maxPrice))));
  const radius = watch.radius ?? (area?.radiusMi > 0 ? milesToKm(area.radiusMi) : null);
  if (radius != null) params.set('radius', String(radius));
  for (const [k, v] of Object.entries(watch.extraParams || {})) {
    if (!MANAGED.has(k) && typeof v === 'string' && v) params.set(k, v);
  }
  if (area?.pickupOnly && !params.has('deliveryMethod')) params.set('deliveryMethod', 'local_pick_up');
  params.set('daysSinceListed', '1');
  params.set('sortBy', SORT_NEWEST);
  params.set('exact', 'false');

  const loc = cleanLocation(watch.location || area?.location);
  const category = String(watch.category || '').replace(/[^a-z0-9_-]/gi, '');
  let path;
  if (!query && category) path = loc ? `/marketplace/${loc}/${category}/` : `/marketplace/category/${category}/`;
  else path = loc ? `/marketplace/${loc}/search/` : '/marketplace/search/';
  return `${base}${path}?${params}`;
}

/**
 * Reads a Marketplace link someone copied from their browser and turns it into
 * watch fields. Returns null if it is not a Marketplace link at all.
 */
export function parseMarketplaceUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!(host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com')) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'marketplace') return null;

  let kind = 'search';
  let location = '';
  let category = '';
  if (parts[1] === 'item') return { kind: 'item', id: parts[2] || '' };
  if (parts[1] === 'search') {
    kind = 'search';
  } else if (parts[1] === 'category') {
    kind = 'browse';
    category = parts[2] || '';
  } else if (parts[1]) {
    location = parts[1];
    if (parts[2] === 'search') kind = 'search';
    else if (parts[2]) {
      kind = 'browse';
      category = parts[2];
    } else kind = 'browse';
  } else {
    kind = 'browse';
  }

  const sp = u.searchParams;
  const extraParams = {};
  for (const [k, v] of sp) if (!MANAGED.has(k) && v) extraParams[k] = v;
  return {
    kind,
    location,
    category,
    query: (sp.get('query') || '').trim(),
    minPrice: toNumber(sp.get('minPrice')),
    maxPrice: toNumber(sp.get('maxPrice')),
    radius: toNumber(sp.get('radius')),
    extraParams,
  };
}

export const itemUrl = (id, base = 'https://www.facebook.com') => `${base}/marketplace/item/${id}/`;
