// Builds src/data/places-us.json, the town lookup behind "too far away", from
// the US Census Bureau's Gazetteer file of places (public domain):
//
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip
//
// Usage: node tools/build-places.js path/to/2024_Gaz_place_national.txt
//
// Each place keeps its state, its name as Facebook would write it ("Tampa",
// not "Tampa city"), its location to about 1 km, and a rough size, so a
// listing from the far side of a big city isn't mistaken for far away.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeKey } from '../src/places.js';

const SOURCE_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'places-us.json');

// What the Census adds after a place's name, which nobody writes on Facebook.
const SUFFIX =
  /\s+(city and borough|consolidated government|unified government|metropolitan government|metro government|urban county|zona urbana|comunidad|municipality|corporation|plantation|borough|village|town|city|CDP)(\s+\(balance\))?$/i;
const GOVERNMENT = /(consolidated|unified|metropolitan|metro) government|urban county|\(balance\)/i;

// Names people use for places the Census files under another name.
const ALIASES = {
  NY: { brooklyn: 'new york', queens: 'new york', bronx: 'new york', 'the bronx': 'new york', manhattan: 'new york', 'staten island': 'new york', 'new york city': 'new york' },
  HI: { honolulu: 'urban honolulu' },
};

function build(file) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = rows.shift().split('\t').map((h) => h.trim());
  const col = (name) => {
    const i = head.indexOf(name);
    if (i === -1) throw new Error(`Column ${name} not found. Is this the Census places Gazetteer file?`);
    return i;
  };
  const [cState, cName, cLand, cLat, cLon] = ['USPS', 'NAME', 'ALAND_SQMI', 'INTPTLAT', 'INTPTLONG'].map(col);
  const states = {};
  let count = 0;
  const add = (st, key, entry) => {
    if (!key) return;
    const s = (states[st] ||= {});
    const list = (s[key] ||= []);
    // The same name twice in a state at (nearly) the same spot is one place.
    if (!list.some((e) => Math.abs(e[0] - entry[0]) < 5 && Math.abs(e[1] - entry[1]) < 5)) list.push(entry);
  };
  for (const line of rows) {
    const f = line.split('\t').map((x) => x.trim());
    if (f.length < head.length - 1 || !f[cState]) continue;
    const lat = Number(f[cLat]);
    const lon = Number(f[cLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const r = Math.round(Math.sqrt(Number(f[cLand]) / Math.PI)); // miles, as if it were a circle
    const entry = r >= 2 ? [Math.round(lat * 100), Math.round(lon * 100), r] : [Math.round(lat * 100), Math.round(lon * 100)];
    const raw = f[cName];
    const name = raw.replace(SUFFIX, '').replace(/\s+\(balance\)$/i, '');
    add(f[cState], placeKey(name), entry);
    count++;
    // "Nashville-Davidson metropolitan government": people say Nashville.
    if (GOVERNMENT.test(raw) && /[-/]/.test(name)) add(f[cState], placeKey(name.split(/[-/]/)[0]), entry);
  }
  for (const [st, map] of Object.entries(ALIASES)) {
    for (const [alias, target] of Object.entries(map)) {
      const hit = states[st]?.[placeKey(target)];
      if (hit) states[st][placeKey(alias)] ||= hit;
    }
  }
  // One entry per name stays a flat [lat, lon(, r)]; more than one becomes a list of them.
  for (const map of Object.values(states)) for (const [k, list] of Object.entries(map)) map[k] = list.length === 1 ? list[0] : list;
  return { count, states };
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/build-places.js path/to/2024_Gaz_place_national.txt');
  process.exit(1);
}
const { count, states } = build(file);
const out = {
  source: 'US Census Bureau, 2024 Gazetteer Files: places. Public domain.',
  url: SOURCE_URL,
  format: 'states[ST][name] = [lat*100, lon*100, radius miles if 2+], or a list of those when a state has more than one place by that name',
  states,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
const names = Object.values(states).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`${count} places, ${names} names in ${Object.keys(states).length} states -> ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
