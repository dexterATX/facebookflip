import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, extractFromJsonTexts, parseJsonStream, parsePriceText, normalizeDomCard, balancedSlice } from '../src/facebook/extract.js';
import { classify } from '../src/facebook/client.js';
import { MockFacebook } from '../tools/mock-facebook.js';

const BASE = 'https://www.facebook.com';

function mockPage(query = 'bike', search = '') {
  const mock = new MockFacebook({ autoAdd: false, seedCount: 12 });
  mock.base = 'http://mock';
  const html = mock.searchPage(new URL(`http://mock/marketplace/tampa/search/?query=${query}${search}`));
  return { mock, html };
}

test('extracts every listing from a realistic search page and skips the sponsored one', () => {
  const { mock, html } = mockPage();
  const { listings, signals } = extractFromHtml(html, { base: BASE });
  const expected = [...mock.streams.values()][0].items;
  assert.equal(listings.length, expected.length);
  assert.ok(!listings.some((l) => l.id === '999999999999001'), 'ad story must be ignored');
  assert.ok(signals.jsonScripts >= 3);
  const src = expected.sort((a, b) => b.creationTime - a.creationTime)[0];
  const got = listings.find((l) => l.id === src.id);
  assert.equal(got.title, src.title);
  assert.equal(got.price, src.price);
  assert.equal(got.priceText, `$${src.price.toLocaleString('en-US')}`);
  assert.equal(got.creationTime, src.creationTime * 1000);
  assert.equal(got.locationText, `${src.city}, Florida`);
  assert.equal(got.city, src.city);
  assert.equal(got.photo, src.photo);
  assert.equal(got.url, `${BASE}/marketplace/item/${src.id}/`);
  assert.equal(got.sold, false);
});

test('handles the exact shape Facebook embeds (escaped markup, duplicates, nulls)', () => {
  const node = {
    id: '1054280080442808',
    primary_listing_photo: { image: { uri: 'https://scontent.xx.fbcdn.net/v/t45/abc.jpg?oe=1' }, id: '928285686952534' },
    creation_time: 1784161765,
    listing_price: { formatted_amount: '$40', amount: '40.00' },
    strikethrough_price: null,
    location: { reverse_geocode: { city: 'San Francisco', state: 'CA', city_page: { display_name: 'San Francisco, California', id: '114952118516947' } } },
    is_hidden: false,
    is_live: true,
    is_pending: false,
    is_sold: false,
    marketplace_listing_category_id: '1583634935226685',
    marketplace_listing_title: 'Black L-Shaped Corner Desk <with> Monitor Shelf',
    marketplace_listing_seller: null,
    delivery_types: ['IN_PERSON'],
  };
  const thin = { id: '1054280080442808', marketplace_listing_title: 'Black L-Shaped Corner Desk <with> Monitor Shelf' };
  const payload = { data: { marketplace_search: { feed_units: { edges: [{ node: { listing: thin } }, { node: { listing: node } }] } } } };
  const html = `<html><script type="application/json" data-sjs>${JSON.stringify(payload).replace(/</g, '\\u003C')}</script></html>`;
  const { listings } = extractFromHtml(html, { base: BASE });
  assert.equal(listings.length, 1);
  const l = listings[0];
  assert.equal(l.title, 'Black L-Shaped Corner Desk <with> Monitor Shelf');
  assert.equal(l.price, 40);
  assert.equal(l.priceText, '$40');
  assert.equal(l.currency, 'USD');
  assert.equal(l.creationTime, 1784161765000);
  assert.equal(l.photo, 'https://scontent.xx.fbcdn.net/v/t45/abc.jpg?oe=1');
  assert.deepEqual(l.deliveryTypes, ['IN_PERSON']);
});

test('reads a payload inlined in a normal script when no JSON script has it', () => {
  const inner = JSON.stringify({ edges: [{ node: { listing: { id: '123456789012', marketplace_listing_title: 'Couch "comfy" {big}', listing_price: { amount: '120.00', formatted_amount: '$120' } } } }] });
  const html = `<script>window.__x = {"marketplace_search":{"feed_units":${inner}}};</script>`;
  const { listings } = extractFromHtml(html);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Couch "comfy" {big}');
  assert.equal(balancedSlice('{"a":"}"}x', 0), '{"a":"}"}');
});

test('spots "no results", login forms and the temporary block page', () => {
  const none = extractFromHtml(`<script type="application/json">{"x":{"feed_units":{"edges":[{"node":{"__typename":"MarketplaceSearchFeedNoResults"}}]}}}</script>`);
  assert.equal(none.signals.noResults, true);
  const login = extractFromHtml('<form id="login_form" action="/login/device-based/regular/login/"></form>');
  assert.equal(login.signals.loginForm, true);
  const blocked = extractFromHtml('<h2>You’re Temporarily Blocked</h2>');
  assert.equal(blocked.signals.rateLimited, true);
});

test('parses GraphQL bodies with the for(;;) guard and several documents per response', () => {
  const doc = (id) => JSON.stringify({ data: { node: { listing: { id, marketplace_listing_title: `Item ${id}`, listing_price: { amount: '5.00' } } } } });
  const text = `for (;;);${doc('111111111')}\n${doc('222222222')}\n{"label":"partial`;
  assert.equal(parseJsonStream(text).length, 2);
  const { listings } = extractFromJsonTexts([text, doc('111111111')]);
  assert.deepEqual(listings.map((l) => l.id).sort(), ['111111111', '222222222']);
  assert.equal(extractFromJsonTexts(['{"errors":[{"code":1675004,"message":"Rate limit exceeded"}]}']).signals.rateLimited, true);
});

test('price text parsing covers the common formats', () => {
  assert.equal(parsePriceText('$1,234'), 1234);
  assert.equal(parsePriceText('$1,234.50'), 1234.5);
  assert.equal(parsePriceText('Free'), 0);
  assert.equal(parsePriceText('FREE'), 0);
  assert.equal(parsePriceText('1.234,50 €'), 1234.5);
  assert.equal(parsePriceText('€1.234'), 1234);
  assert.equal(parsePriceText('£40'), 40);
  assert.equal(parsePriceText(''), null);
  assert.equal(parsePriceText('Make offer'), null);
});

test('reads visible cards as a last resort', () => {
  const l = normalizeDomCard({ href: 'https://www.facebook.com/marketplace/item/987654321012/?ref=search', text: '$150\n$200\nTrek bike\nTampa, FL\n12 miles away', img: 'https://scontent/x.jpg' });
  assert.equal(l.id, '987654321012');
  assert.equal(l.price, 150);
  assert.equal(l.wasPrice, 200);
  assert.equal(l.title, 'Trek bike');
  assert.equal(l.locationText, 'Tampa, FL');
  assert.equal(normalizeDomCard({ href: '/marketplace/you/' }), null);
});

test('classify: listings win; otherwise each failure gets the right code', () => {
  const { html } = mockPage();
  assert.equal(classify({ status: 200, finalUrl: `${BASE}/login/?next=x`, html }, { engine: 'fast' }).code, 'OK');
  const c = (raw, opts = {}) => classify({ status: 200, finalUrl: `${BASE}/marketplace/tampa/search/`, html: '<html></html>', ...raw }, { engine: 'fast', ...opts }).code;
  assert.equal(c({ finalUrl: `${BASE}/login/?next=abc` }), 'LOGIN_REQUIRED');
  assert.equal(c({ finalUrl: `${BASE}/checkpoint/1501092823525282/` }), 'CHECKPOINT');
  assert.equal(c({ status: 429 }), 'RATE_LIMITED');
  assert.equal(c({ finalUrl: `${BASE}/marketplace/category/search/?query=x` }, { hadLocation: true }), 'BAD_LOCATION');
  assert.equal(c({ status: 500 }), 'HTTP_ERROR');
  assert.equal(c({ html: '<form id="login_form"></form>' }), 'LOGIN_REQUIRED');
  assert.equal(c({}), 'EMPTY');
  const none = classify({ status: 200, finalUrl: BASE, html: '<script type="application/json">{"__typename":"MarketplaceSearchFeedNoResults"}</script>' }, { engine: 'fast' });
  assert.equal(none.ok, true);
  assert.equal(none.listings.length, 0);
});
