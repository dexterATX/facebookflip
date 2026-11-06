// Towns, and how far away they are.
//
// Facebook says which town a listing is in ("Brandon, FL"), not exactly where
// it is. This looks the town up in the US Census list of places
// (src/data/places-us.json, built by tools/build-places.js) for roughly
// where it is and how big it is. A town that isn't in the list is unknown,
// never guessed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'places-us.json');
let states = null;

function load() {
  if (!states) {
    try {
      states = JSON.parse(fs.readFileSync(FILE, 'utf8')).states || {};
    } catch {
      states = {}; // without the list, no town is known, so nothing is ever "too far"
    }
  }
  return states;
}

/** A town's name the way the list stores it: "St. Petersburg" -> "saint petersburg". */
export function placeKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents: "Mayagüez" -> "mayaguez"
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/\bste\.?\s+/g, 'sainte ')
    .replace(/\bft\.?\s+/g, 'fort ')
    .replace(/\bmt\.?\s+/g, 'mount ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Where a town is: [{ lat, lon, r }] (r = rough radius in miles; several when a state has more than one by that name), or null. */
export function findPlace(city, stateCode) {
  if (!city || !stateCode) return null;
  const hit = load()[stateCode]?.[placeKey(city)];
  if (!hit) return null;
  return (Array.isArray(hit[0]) ? hit : [hit]).map(([lat, lon, r = 0]) => ({ lat: lat / 100, lon: lon / 100, r }));
}

/** Miles between two points. */
export function milesBetween(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far a town is from a point: `middle` to its middle, and `edge` to its
 * near edge (a big city reaches miles out from its middle). Of several towns
 * by that name, the nearest. null when the town is unknown.
 */
export function distanceTo(center, city, stateCode) {
  const spots = findPlace(city, stateCode);
  if (!spots || !center) return null;
  let best = null;
  for (const p of spots) {
    const middle = milesBetween(center, p);
    const edge = Math.max(0, middle - p.r);
    if (!best || edge < best.edge) best = { edge, middle };
  }
  return best;
}

const titleCase = (key) => key.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The town a point is in, or nearest to: { name, state, miles }, or null.
 * Distance counts relative to a town's size, so a point in a big city is
 * named for the city, not a small place next door ("Orlando", not "Holden
 * Heights"): a town's Census point can sit miles from its downtown.
 */
export function nearestTown(center) {
  if (!center) return null;
  let best = null;
  for (const [state, towns] of Object.entries(load())) {
    for (const [key, hit] of Object.entries(towns)) {
      for (const [lat, lon, r = 0] of Array.isArray(hit[0]) ? hit : [hit]) {
        if (Math.abs(lat / 100 - center.lat) > 2) continue; // far off: skip the math
        const middle = milesBetween(center, { lat: lat / 100, lon: lon / 100 });
        const score = middle / (r + 1);
        if (!best || score < best.score) best = { key, state, score, middle };
      }
    }
  }
  return best && { name: titleCase(best.key), state: best.state, miles: Math.round(best.middle) };
}
