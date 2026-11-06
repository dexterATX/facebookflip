// Your area: one place and distance for every search, and what counts as local.
//
// Facebook's location search centers on your area, but it mixes in listings
// that only ship (from anywhere in the country), and sometimes sellers from
// farther away. FlipRadar asks Facebook for local pickup only, then drops
// anything that still isn't local: ship-only listings, listings from outside
// your state(s), and listings from towns outside the distance searched.

import { distanceTo } from './places.js';

export const DEFAULT_AREA = {
  location: '', // Facebook's name for the place: a city ("tampa") or a place id from a Marketplace link
  label: '', // what to call it ("Tampa, FL")
  radiusMi: 0, // distance in miles (0 = Facebook's default for the place)
  pickupOnly: true, // only listings you can pick up locally
  states: [], // only listings in these states (two-letter codes); empty = no state check
  autoStates: true, // fill in "states" from the results in your area (again when the place changes); off once you set them
};

// The distances Facebook offers, in miles.
export const RADIUS_MI = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500];

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
const CODES = new Set(Object.values(STATES));

/** "Florida", "FL", " fl " -> "FL". Anything else -> "". */
export function stateCode(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (upper.length === 2 && CODES.has(upper)) return upper;
  return STATES[s.toLowerCase().replace(/\s+/g, ' ')] || '';
}

/** "fl, Georgia, xx" -> ["FL", "GA"] */
export function stateList(input) {
  const parts = Array.isArray(input) ? input : String(input || '').split(/[,;/]+/);
  return [...new Set(parts.map(stateCode).filter(Boolean))];
}

/** Can this listing be picked up, as far as Facebook says? (Unknown counts as yes.) */
const canPickUp = (types) => !Array.isArray(types) || !types.length || types.some((t) => !/SHIP/i.test(String(t)));
/** Can it be shipped to you? (Unknown counts as no.) */
const canShip = (types) => Array.isArray(types) && types.some((t) => /SHIP/i.test(String(t)));

const placeOf = (l) => l.locationText || [l.city, l.state].filter(Boolean).join(', ') || 'somewhere else';

/**
 * Why a listing isn't local, or null if it is (or there's no way to tell).
 * `area` is the rules for one search: your area's settings, plus `center`
 * { lat, lon } and `radiusMi`, where Facebook searched and how far, when known.
 */
export function notLocal(listing, area) {
  if (!area) return null;
  if (area.pickupOnly && !canPickUp(listing.deliveryTypes)) return `Ships only, from ${placeOf(listing)}`;
  // With shipping allowed, one that ships can come from anywhere. Only pickup has to be near.
  if (!area.pickupOnly && canShip(listing.deliveryTypes)) return null;
  const st = stateCode(listing.state);
  if (area.states?.length && st && !area.states.includes(st)) return `Outside your area (${placeOf(listing)})`;
  if (area.center && area.radiusMi > 0 && st) {
    // Its town is clearly outside the distance searched. Some slack: Facebook
    // goes by where the listing is, and all that's known here is its town.
    const d = distanceTo(area.center, listing.city, st);
    if (d && d.edge > area.radiusMi * 1.1 + 3) return `Too far: ${placeOf(listing)}, about ${Math.round(d.middle)} mi away`;
  }
  return null;
}

/**
 * Which place and distance a watch searches: its own location, or your
 * area's. A search's center is only trusted for the place it was read from.
 */
export const searchPlace = (watch, area) => `${watch?.location || area?.location || ''}|${watch?.radius ?? area?.radiusMi ?? ''}`;

/**
 * The state nearly all local listings are in, or null when it's mixed (near a
 * state line, say) or there are too few to tell. Used to fill in "only these
 * states" once, which you can change.
 */
export function homeState(listings, { min = 8, share = 0.9 } = {}) {
  const counts = new Map();
  let n = 0;
  for (const l of listings) {
    const st = stateCode(l.state);
    if (!st || !canPickUp(l.deliveryTypes)) continue;
    counts.set(st, (counts.get(st) || 0) + 1);
    n++;
  }
  if (n < min) return null;
  const [top, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return count / n >= share ? top : null;
}

/** Miles to the kilometers Facebook's search works in. */
export const milesToKm = (mi) => Math.round(mi * 1.609344);

/** A distance in kilometers (from a Marketplace link) to the nearest distance Facebook offers in miles. */
export function nearestMiles(km) {
  const mi = km / 1.609344;
  return RADIUS_MI.reduce((best, m) => (Math.abs(m - mi) < Math.abs(best - mi) ? m : best));
}
