import test from 'node:test';
import assert from 'node:assert/strict';
import { notLocal, homeState, stateCode, stateList, nearestMiles, milesToKm, DEFAULT_AREA } from '../src/area.js';
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
