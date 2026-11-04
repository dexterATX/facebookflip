import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseMarketplaceUrl, cleanLocation } from '../src/facebook/urls.js';
import { parseCookieInput, CookieJar, hasSession, toCookieHeader } from '../src/facebook/cookies.js';
import { passesFilters, filterReason, hasTerm, titleWords } from '../src/deals.js';

test('search links are always newest-first and last-24-hours', () => {
  const u = new URL(buildSearchUrl({ query: 'road bike', location: 'Tampa', minPrice: 50.6, maxPrice: 600.2 }));
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/marketplace/tampa/search/');
  assert.equal(u.searchParams.get('query'), 'road bike');
  assert.equal(u.searchParams.get('sortBy'), 'creation_time_descend');
  assert.equal(u.searchParams.get('daysSinceListed'), '1');
  assert.equal(u.searchParams.get('minPrice'), '50');
  assert.equal(u.searchParams.get('maxPrice'), '601');
  const noLoc = new URL(buildSearchUrl({ query: 'ps5', extraParams: { itemCondition: 'new', sortBy: 'best_match' } }, 'http://127.0.0.1:9'));
  assert.equal(noLoc.pathname, '/marketplace/search/');
  assert.equal(noLoc.searchParams.get('itemCondition'), 'new');
  assert.equal(noLoc.searchParams.get('sortBy'), 'creation_time_descend', 'pasted sort must be overridden');
  assert.equal(new URL(buildSearchUrl({ category: 'free', location: '108424279189115' })).pathname, '/marketplace/108424279189115/free/');
  assert.equal(cleanLocation('San Francisco'), 'sanfrancisco');
  assert.equal(cleanLocation(' 112548152092705 '), '112548152092705');
});

test('pasted Marketplace links become watch fields', () => {
  const p = parseMarketplaceUrl('https://www.facebook.com/marketplace/108424279189115/search/?minPrice=100&maxPrice=500&daysSinceListed=7&sortBy=best_match&query=sectional%20couch&exact=false&itemCondition=used_like_new');
  assert.equal(p.kind, 'search');
  assert.equal(p.location, '108424279189115');
  assert.equal(p.query, 'sectional couch');
  assert.equal(p.minPrice, 100);
  assert.equal(p.maxPrice, 500);
  assert.deepEqual(p.extraParams, { itemCondition: 'used_like_new' });
  assert.equal(parseMarketplaceUrl('https://m.facebook.com/marketplace/search/?query=ps5').query, 'ps5');
  assert.equal(parseMarketplaceUrl('https://www.facebook.com/marketplace/nyc/free').category, 'free');
  assert.equal(parseMarketplaceUrl('https://www.facebook.com/marketplace/item/123456/').kind, 'item');
  assert.equal(parseMarketplaceUrl('https://example.com/marketplace/search?query=x'), null);
  assert.equal(parseMarketplaceUrl('not a link'), null);
});

test('cookie input: header string, JSON export and cookies.txt', () => {
  const a = parseCookieInput('c_user=100012345; xs=12%3Aabc%3A2; datr=zz; bad name=1');
  assert.deepEqual(a.map((c) => c.name), ['c_user', 'xs', 'datr']);
  assert.ok(hasSession(a));
  const b = parseCookieInput(JSON.stringify([
    { name: 'c_user', value: '1', domain: '.facebook.com' },
    { name: 'xs', value: '2', domain: '.facebook.com' },
    { name: 'other', value: '3', domain: '.example.com' },
  ]));
  assert.equal(toCookieHeader(b), 'c_user=1; xs=2');
  const c = parseCookieInput('.facebook.com\tTRUE\t/\tTRUE\t1999999999\tc_user\t42\n#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1999999999\txs\tabc');
  assert.equal(toCookieHeader(c), 'c_user=42; xs=abc');
  assert.deepEqual(parseCookieInput(''), []);
});

test('cookie jar keeps what Facebook sets, drops what it deletes, lets the user override', () => {
  const jar = new CookieJar();
  jar.absorb(['datr=abc; Max-Age=63072000; Path=/; HttpOnly', 'fr=1; expires=Thu, 01 Jan 2099 00:00:00 GMT']);
  assert.equal(jar.header(), 'datr=abc; fr=1');
  jar.absorb('fr=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT');
  assert.equal(jar.header([{ name: 'datr', value: 'mine' }, { name: 'c_user', value: '9' }]), 'datr=mine; c_user=9');
});

test('filters: price range, $1 bait, include/exclude words', () => {
  const w = { minPrice: 50, maxPrice: 500, include: [], exclude: ['broke', 'for parts'] };
  const s = { hidePlaceholderPrices: true };
  assert.equal(passesFilters({ title: 'Trek bike', price: 120 }, w, s), true);
  assert.equal(passesFilters({ title: 'Trek bike', price: 20 }, w, s), false);
  assert.equal(passesFilters({ title: 'Trek bike', price: 900 }, w, s), false);
  assert.equal(passesFilters({ title: 'Trek bike BROKEN frame', price: 120 }, w, s), false);
  assert.equal(passesFilters({ title: 'Trek bike - for parts!', price: 120 }, w, s), false);
  assert.equal(passesFilters({ title: 'Trek bike (partsy)', price: 120 }, w, s), true);
  assert.equal(passesFilters({ title: 'Message me', price: 1 }, { include: [], exclude: [] }, s), false);
  assert.equal(passesFilters({ title: 'Free couch', price: 0 }, { include: [], exclude: [] }, s), true, 'free stays');
  const inc = { include: ['trek', 'specialized'], exclude: [] };
  assert.equal(passesFilters({ title: 'Specialized Rockhopper', price: 300 }, inc, s), true);
  assert.equal(passesFilters({ title: 'Huffy cruiser', price: 300 }, inc, s), false);
  assert.ok(hasTerm(' café table ', 'cafe'));
});

test('filter reasons say exactly why a listing went to Unsorted', () => {
  const w = { minPrice: 50, maxPrice: 500, include: ['trek'], exclude: ['for parts'] };
  const s = { hidePlaceholderPrices: true };
  assert.equal(filterReason({ title: 'Trek bike', price: 120 }, w, s), null);
  assert.equal(filterReason({ title: 'Trek bike', price: 20 }, w, s), 'Under your minimum price ($50)');
  assert.equal(filterReason({ title: 'Trek bike for parts', price: 120 }, w, s), 'Has your skip word "for parts"');
  assert.match(filterReason({ title: 'Huffy bike', price: 120 }, w, s), /must-have words \(trek\)/);
  assert.equal(filterReason({ title: 'Message me', price: 1 }, { ...w, include: [], minPrice: null }, s), '"$1" placeholder price');
  assert.deepEqual([...titleWords('PS5 Disc Edition + 2 controllers, great condition')], ['ps5', 'disc', 'edition', 'controller']);
});
