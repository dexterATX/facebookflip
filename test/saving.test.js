import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, MAX_SAVED_DEALS, csvCell } from '../src/store.js';
import { Monitor, pileOf } from '../src/monitor.js';

const MIN = 60e3;
const DAY = 86400e3;

function setup({ readDetails = false, items = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-save-'));
  const store = new Store(path.join(dir, 'db.json'));
  store.settings.deals.readDetails = readDetails;
  const responses = [];
  const fb = {
    async search() {
      return responses.shift();
    },
    async fetchItem(id) {
      return items[id] ? { ok: true, details: items[id] } : { ok: false, code: 'NO_DETAILS', message: 'none' };
    },
  };
  const sent = [];
  const notifier = { errors: {}, async sendListings(watch, fresh) { sent.push(fresh.map((l) => l.id)); } };
  const monitor = new Monitor({ store, fb, notifier, gapMs: 0 });
  const csvRows = () => (fs.existsSync(store.dealsFile) ? fs.readFileSync(store.dealsFile, 'utf8').trim().split('\n').slice(1) : []);
  return { dir, store, fb, monitor, responses, sent, csvRows, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function drain(monitor) {
  for (let i = 0; i < 400 && (monitor.deepRunning || monitor.deepQueue.length); i++) await new Promise((r) => setTimeout(r, 5));
}

const L = (id, { ageMin = null, price = 100, title = `Item ${id}`, ...rest } = {}) => ({
  id: String(id),
  title,
  price,
  priceText: `$${price}`,
  creationTime: ageMin === null ? null : Date.now() - ageMin * MIN,
  photo: null,
  locationText: 'Tampa, FL',
  url: `https://www.facebook.com/marketplace/item/${id}/`,
  sold: false,
  pending: false,
  live: true,
  hiddenOnFb: false,
  ...rest,
});
const ok = (listings) => ({ ok: true, code: 'OK', message: 'OK', engine: 'fast', ms: 5, listings });
const history = () => [400, 410, 390, 405, 395, 420, 380, 400].map((p, i) => L(900 + i, { ageMin: 600, price: p, title: 'PS5 disc edition console' }));

test('good deals are saved once their closer look passes; ones it rules out are not', async () => {
  const t = setup({
    readDetails: true,
    items: {
      1: { description: 'Works great, pick up today.', condition: 'Used - like new' },
      2: { description: 'Turns on but no picture. For parts or repair.', condition: 'Used - fair' },
    },
  });
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = t.fb.fetchItem.bind(t.fb);
  t.fb.fetchItem = async (id) => {
    await gate;
    return realFetch(id);
  };
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok(history()));
  await t.monitor.scan(w);
  t.responses.push(ok([L(1, { ageMin: 1, price: 210, title: 'PS5 disc edition' }), L(2, { ageMin: 1, price: 200, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  assert.equal(pileOf(t.store.listings['2']), 'deals', 'looks like a deal from the title alone');
  assert.equal(t.store.listings['1'].saved, false, 'not saved before its closer look');
  assert.equal(t.store.listings['2'].saved, false);
  release();
  await drain(t.monitor);
  const good = t.store.listings['1'];
  assert.equal(good.saved, true);
  assert.equal(good.autoSaved, true);
  assert.ok(good.dealSavedAt);
  assert.equal(t.store.listings['2'].saved, false, 'for parts: never saved');
  const rows = t.csvRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0], /PS5 disc edition,210,/);
  assert.match(rows[0], /https:\/\/www\.facebook\.com\/marketplace\/item\/1\/$/);
  assert.equal(t.store.dealsLogged(), 1);
  t.cleanup();
});

test('without a closer look, deals are saved as soon as they are found', async () => {
  const t = setup({ readDetails: false });
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok(history()));
  await t.monitor.scan(w);
  t.responses.push(ok([L(5, { ageMin: 1, price: 210, title: 'PS5 disc edition' }), L(6, { ageMin: 1, price: 390, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  assert.equal(t.store.listings['5'].saved, true);
  assert.equal(t.store.listings['6'].saved, false, 'a fair price is not a deal');
  assert.deepEqual(t.sent, [['5']]);
  t.cleanup();
});

test('saved deals outlive the 7-day cleanup; the newest are kept; your stars always', () => {
  const t = setup();
  const now = Date.now();
  const old = now - 30 * DAY;
  const add = (id, extra) => (t.store.listings[id] = { id, title: `Item ${id}`, price: 10, watchIds: [], firstSeenAt: old, lastSeenAt: old, ...extra });
  add('deal', { saved: true, autoSaved: true, dealSavedAt: old });
  add('star', { saved: true });
  add('plain', {});
  for (let i = 0; i < MAX_SAVED_DEALS + 5; i++) add(`d${i}`, { saved: true, autoSaved: true, dealSavedAt: now - (MAX_SAVED_DEALS + 5 - i) * MIN });
  t.store.prune(now);
  assert.equal(t.store.listings.plain, undefined, 'ordinary listings still go after 7 days');
  assert.ok(t.store.listings.star, 'your stars are never trimmed');
  const autoLeft = Object.values(t.store.listings).filter((l) => l.autoSaved);
  assert.equal(autoLeft.length, MAX_SAVED_DEALS);
  assert.equal(t.store.listings.deal, undefined, 'the oldest saved deals go first once there are too many');
  assert.equal(t.store.listings.d0, undefined);
  assert.ok(t.store.listings[`d${MAX_SAVED_DEALS + 4}`]);
  t.cleanup();
});

test('un-starring a saved deal sticks, even when deals are re-checked', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok(history()));
  await t.monitor.scan(w);
  t.responses.push(ok([L(7, { ageMin: 1, price: 210, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  const l = t.store.listings['7'];
  assert.equal(l.saved, true);
  l.saved = false; // what the star button does
  l.autoSaved = false;
  t.monitor.reevaluate();
  assert.equal(l.saved, false);
  assert.equal(t.csvRows().length, 1, 'still one row: the spreadsheet is a record of what was found');
  t.cleanup();
});

test('the deals spreadsheet is safe to open: quoted text, no formulas from sellers', () => {
  const t = setup();
  const l = { id: '9', title: '=HYPERLINK("http://evil")', price: 50, url: 'https://www.facebook.com/marketplace/item/9/', locationText: 'Tampa, FL', eval: { resale: { value: 120, basis: 'price guide' }, profit: 60, margin: 0.5, confidence: 'medium', flags: [] } };
  t.store.saveDeal(l, { watch: 'Things, misc' });
  t.store.saveDeal(l, { watch: 'Things, misc' }); // once per listing
  const text = fs.readFileSync(t.store.dealsFile, 'utf8');
  assert.ok(text.startsWith('﻿Saved at,Title,Price,'));
  const rows = t.csvRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0], /,"'=HYPERLINK\(""http:\/\/evil""\)",50,120,60,50%,medium,price guide,,"Tampa, FL",,"Things, misc",https:/);
  assert.equal(csvCell('+1 555'), "'+1 555");
  assert.equal(csvCell(-12), '-12');
  assert.equal(csvCell('line one\nline two'), 'line one line two');
  t.cleanup();
});
