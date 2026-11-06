import test from 'node:test';
import assert from 'node:assert/strict';
import { notLocal, homeState, stateCode, stateList, nearestMiles, milesToKm, searchPlace, DEFAULT_AREA } from '../src/area.js';
import { placeKey, findPlace, milesBetween, distanceTo } from '../src/places.js';
import { readRecipe } from '../src/facebook/paging.js';
import { buildSearchUrl } from '../src/facebook/urls.js';

const area = (a = {}) => ({ ...DEFAULT_AREA, ...a });
const pickup = ['IN_PERSON'];
const both = ['IN_PERSON', 'SHIPPING_ONSITE'];
const shipOnly = ['SHIPPING_ONSITE'];

test('state names and codes, however they are typed', () => {
  assert.equal(stateCode('Florida'), 'FL');
  assert.equal(stateCode(' fl '), 'FL');
  assert.equal(stateCode('new  york'), 'NY');
  assert.equal(stateCode('Narnia'), '');
  assert.deepEqual(stateList('fl, Georgia; xx / GA'), ['FL', 'GA']);
});

test('what counts as local', () => {
  const fl = area({ states: ['FL'] });
  assert.equal(notLocal({ deliveryTypes: pickup, state: 'FL' }, fl), null);
  assert.equal(notLocal({ deliveryTypes: both, state: 'FL' }, fl), null, 'pickup or shipping is still local');
  assert.match(notLocal({ deliveryTypes: shipOnly, state: 'CA', city: 'Fresno' }, fl), /^Ships only, from Fresno, CA/);
  assert.match(notLocal({ deliveryTypes: pickup, state: 'GA', locationText: 'Valdosta, GA' }, fl), /^Outside your area \(Valdosta, GA\)/);
  assert.equal(notLocal({ deliveryTypes: [], state: '' }, fl), null, "when Facebook doesn't say, it isn't dropped");
  assert.equal(notLocal({ deliveryTypes: shipOnly, state: 'FL' }, area({ pickupOnly: false })), null, 'shipping allowed when pickup-only is off');
  const shipping = area({ pickupOnly: false, states: ['FL'], center: { lat: 27.9506, lon: -82.4572 }, radiusMi: 40 });
  assert.equal(notLocal({ deliveryTypes: shipOnly, city: 'Atlanta', state: 'GA' }, shipping), null, 'with shipping allowed, one that ships can come from anywhere');
  assert.equal(notLocal({ deliveryTypes: both, city: 'Miami', state: 'FL' }, shipping), null, 'pickup or shipping: it can be shipped');
  assert.match(notLocal({ deliveryTypes: pickup, city: 'Atlanta', state: 'GA' }, shipping), /^Outside your area/, 'but pickup-only has to be near');
  assert.match(notLocal({ deliveryTypes: pickup, city: 'Miami', state: 'FL' }, shipping), /^Too far/);
  assert.equal(notLocal({ deliveryTypes: pickup, state: 'GA' }, area({ states: [] })), null, 'no state check when none are set');
});

test('your home state is learned only when the results clearly agree', () => {
  const l = (state, types = pickup) => ({ state, deliveryTypes: types });
  assert.equal(homeState([...Array(9)].map(() => l('FL')).concat(l('GA'))), 'FL', '9 of 10');
  assert.equal(homeState([...Array(6)].map(() => l('FL')).concat([...Array(4)].map(() => l('GA')))), null, 'near a state line: mixed');
  assert.equal(homeState([...Array(5)].map(() => l('FL'))), null, 'too few to tell');
  assert.equal(homeState([...Array(9)].map(() => l('FL')).concat([...Array(5)].map(() => l('CA', shipOnly)))), 'FL', 'ship-only ones from elsewhere are ignored');
});

test("a link's distance (in km) becomes the nearest distance Facebook offers in miles", () => {
  assert.equal(nearestMiles(65), 40);
  assert.equal(nearestMiles(64), 40);
  assert.equal(nearestMiles(161), 100);
  assert.equal(nearestMiles(805), 500);
  assert.equal(nearestMiles(2), 1);
  assert.equal(milesToKm(40), 64);
});

test('every search uses your area unless the watch names its own place', () => {
  const a = area({ location: '112548152092705', radiusMi: 40, pickupOnly: true });
  const u = new URL(buildSearchUrl({ query: 'bike' }, 'https://www.facebook.com', a));
  assert.equal(u.pathname, '/marketplace/112548152092705/search/');
  assert.equal(u.searchParams.get('radius'), '64');
  assert.equal(u.searchParams.get('deliveryMethod'), 'local_pick_up');
  const own = new URL(buildSearchUrl({ query: 'bike', location: 'orlando', radius: 20 }, 'https://www.facebook.com', a));
  assert.equal(own.pathname, '/marketplace/orlando/search/');
  assert.equal(own.searchParams.get('radius'), '20');
  const anyDelivery = new URL(buildSearchUrl({ query: 'bike' }, 'https://www.facebook.com', area({ location: 'tampa', pickupOnly: false })));
  assert.equal(anyDelivery.searchParams.get('deliveryMethod'), null);
  assert.equal(anyDelivery.searchParams.get('radius'), null, "no distance set: Facebook's default");
});

test('towns are found the way people write them', () => {
  assert.equal(placeKey('St. Petersburg'), 'saint petersburg');
  assert.equal(placeKey('Saint Petersburg'), 'saint petersburg');
  assert.equal(placeKey('Ft. Myers'), 'fort myers');
  assert.equal(placeKey("Coeur d'Alene"), 'coeur dalene');
  assert.equal(placeKey('Mayagüez'), 'mayaguez');
  const tampa = findPlace('Tampa', 'FL');
  assert.equal(tampa.length, 1);
  assert.ok(Math.abs(tampa[0].lat - 27.97) < 0.1 && Math.abs(tampa[0].lon + 82.47) < 0.1);
  assert.ok(findPlace('Brandon', 'FL'), 'unincorporated communities too (Census "CDP")');
  assert.ok(findPlace('Brooklyn', 'NY'), 'the city a borough belongs to');
  assert.ok(findPlace('Nashville', 'TN'), '"Nashville-Davidson metropolitan government"');
  assert.equal(findPlace('Narnia', 'FL'), null);
  assert.equal(findPlace('Tampa', ''), null, 'no state, no guess');
  const miami = findPlace('Miami', 'FL')[0];
  assert.ok(Math.abs(milesBetween(tampa[0], miami) - 204) < 5, 'Tampa to Miami is about 204 miles');
});

test('distance counts from the near edge of a town, and the nearest of towns sharing a name', () => {
  const tampa = { lat: 27.9506, lon: -82.4572 };
  const jax = distanceTo(tampa, 'Jacksonville', 'FL');
  assert.ok(jax.middle - jax.edge >= 10, 'Jacksonville is big: its edge is well short of its middle');
  const louisville = distanceTo({ lat: 38.25, lon: -85.76 }, 'Louisville', 'KY');
  assert.ok(louisville.edge < 1, 'downtown Louisville');
  assert.equal(distanceTo(tampa, 'Narnia', 'FL'), null);
});

test('too far: towns clearly outside the distance searched are dropped, unknown towns are kept', () => {
  const rules = { ...DEFAULT_AREA, pickupOnly: true, center: { lat: 27.9506, lon: -82.4572 }, radiusMi: 40 };
  const at = (city) => ({ deliveryTypes: pickup, city, state: 'FL', locationText: `${city}, FL` });
  for (const near of ['Tampa', 'Brandon', 'Lutz', 'Wesley Chapel', 'St. Petersburg', 'Clearwater', 'Lakeland', 'Sarasota']) {
    assert.equal(notLocal(at(near), rules), null, `${near} is within 40 miles`);
  }
  assert.equal(notLocal(at('Orlando'), rules), 'Too far: Orlando, FL, about 80 mi away');
  assert.match(notLocal(at('Miami'), rules), /^Too far: Miami, FL, about 20\d mi away$/);
  assert.equal(notLocal(at('Somewhere Unlisted'), rules), null, "a town the list doesn't know is kept");
  assert.equal(notLocal(at('Orlando'), { ...rules, radiusMi: 100 }), null, 'within a 100-mile search');
  assert.equal(notLocal(at('Orlando'), { ...rules, center: null }), null, 'no distance check without knowing where the search was');
});

test("a search page's own location filter tells where it searched, and how far", () => {
  const vars = { count: 24, cursor: null, params: { browse_request_params: { filter_location_latitude: 27.9506, filter_location_longitude: -82.4572, filter_radius_km: 65 } } };
  const html = `<script type="application/json">${JSON.stringify({ require: [['RelayPreloader', 'x', [], [{ queryID: '9000000000000001', variables: vars }]]] })}</script>`;
  assert.deepEqual(readRecipe(html).center, { lat: 27.9506, lon: -82.4572, radiusKm: 65 });
  const buyOnly = `<script type="application/json">${JSON.stringify({ x: { buyLocation: { latitude: '28.5', longitude: '-81.4' } } })}</script>`;
  assert.deepEqual(readRecipe(buyOnly).center, { lat: 28.5, lon: -81.4, radiusKm: null });
  assert.equal(readRecipe('<script type="application/json">{"filter_location_latitude":0,"filter_location_longitude":0}</script>').center, null, 'not a real place');
  assert.equal(readRecipe('<html></html>').center, null);
});

test("a search's center is tied to the place and distance it was read for", () => {
  const area = { ...DEFAULT_AREA, location: 'tampa', radiusMi: 40 };
  assert.equal(searchPlace({}, area), 'tampa|40');
  assert.equal(searchPlace({ location: 'orlando' }, area), 'orlando|40', 'its own place, your distance');
  assert.equal(searchPlace({ location: 'orlando', radius: 20 }, area), 'orlando|20');
  assert.notEqual(searchPlace({}, { ...area, location: 'miami' }), searchPlace({}, area), 'moving your area makes the old center stale');
});
