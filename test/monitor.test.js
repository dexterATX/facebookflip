import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor, inQuietHours, pileOf } from '../src/monitor.js';

const MIN = 60e3;

function setup({ readDetails = false, ai = null, items = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-test-'));
  const store = new Store(path.join(dir, 'db.json'));
  store.settings.deals.readDetails = readDetails;
  const responses = [];
  const fb = {
    calls: [],
    itemCalls: [],
    async search(url) {
      this.calls.push(url);
      return responses.shift();
    },
    async fetchItem(id) {
      this.itemCalls.push(id);
      return items[id] ? { ok: true, details: items[id] } : { ok: false, code: 'NO_DETAILS', message: 'none' };
    },
  };
  const sent = [];
  const notifier = { errors: {}, async sendListings(watch, fresh, drops) { sent.push({ watch: watch.name, fresh: fresh.map((l) => l.id), drops: drops.map((l) => l.id) }); } };
  const monitor = new Monitor({ store, fb, notifier, ai, gapMs: 0 });
  return { store, fb, notifier, monitor, responses, sent, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
// Eight consoles asking ~$400 (posted hours ago) so the price comparison has data.
const history = () => [400, 410, 390, 405, 395, 420, 380, 400].map((p, i) => L(900 + i, { ageMin: 600, price: p, title: 'PS5 disc edition console' }));

test('first check is a quiet baseline, except listings posted inside the alert window', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'Bikes', query: 'bike', alertMode: 'all' });
  t.responses.push(ok([L(1, { ageMin: 5 }), L(2, { ageMin: 300 }), L(3)]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent, [{ watch: 'Bikes', fresh: ['1'], drops: [] }]);
  assert.equal(t.store.listings['2'].baseline, true);
  assert.equal(t.store.listings['1'].baseline, false);
  assert.equal(Object.keys(t.store.listings).length, 3, 'baseline listings still show in the feed');
  assert.ok(w.baselineAt);
  t.cleanup();
});

test('later checks alert on new ids: fresh ones or ones with no post time; old re-surfaced ones stay quiet', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'Bikes', query: 'bike', alertMode: 'all' });
  t.responses.push(ok([L(1, { ageMin: 200 })]));
  await t.monitor.scan(w);
  t.responses.push(ok([L(1, { ageMin: 202 }), L(10, { ageMin: 1 }), L(11, { ageMin: 400 }), L(12)]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.at(-1).fresh.sort(), ['10', '12']);
  assert.ok(t.store.listings['11'], 'old listing is still recorded');
  assert.equal(t.store.listings['10'].alertedAt > 0, true);
  t.cleanup();
});

test('deals mode (the default): only deals alert; everything else is kept in Unsorted with a reason', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  assert.equal(w.alertMode, 'deals');
  t.responses.push(ok(history()));
  await t.monitor.scan(w);
  t.responses.push(
    ok([
      L(1, { ageMin: 2, price: 220, title: 'PS5 disc edition' }),
      L(2, { ageMin: 2, price: 380, title: 'PS5 disc edition' }),
      L(3, { ageMin: 2, price: 100, title: 'PS5 disc edition for parts' }),
    ]),
  );
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.map((s) => s.fresh), [['1']]);
  const get = (id) => t.store.listings[id];
  assert.equal(pileOf(get('1')), 'deals');
  // Median ask of the 8 consoles + the new $380 one = $400; x90% = $360; minus $220 and $10.
  // (The $100 "for parts" one is kept out of the comparison.)
  assert.equal(get('1').eval.profit, 130);
  assert.ok(t.store.data.comps.find((c) => c.id === '3').junk);
  assert.equal(pileOf(get('2')), 'unsorted');
  assert.match(get('2').eval.headline, /Priced above resale|Only/);
  assert.equal(pileOf(get('3')), 'unsorted');
  assert.match(get('3').eval.headline, /for parts/);
  t.cleanup();
});

test('the full listing can veto a deal before any alert goes out', async () => {
  const t = setup({
    readDetails: true,
    items: {
      1: { description: 'Works great, pick up today.', condition: 'Used - like new' },
      2: { description: 'Turns on but no picture. Selling as is.\nFor parts or repair.', condition: 'Used - fair' },
    },
  });
  // Hold the listing pages until we say so, to prove nothing alerts before they're read.
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
  assert.equal(t.sent.length, 0, 'no alert before the closer look');
  release();
  await drain(t.monitor);
  assert.deepEqual(t.fb.itemCalls.sort(), ['1', '2']);
  assert.deepEqual(t.sent.map((s) => s.fresh), [['1']]);
  assert.equal(pileOf(t.store.listings['2']), 'unsorted');
  assert.ok(t.store.listings['2'].eval.flags.some((f) => f.code === 'parts'));
  t.cleanup();
});

test('the AI second opinion runs only for possible deals, within the daily cap', async () => {
  const asked = [];
  const ai = {
    enabled: () => true,
    hasBudget: () => asked.length < 1,
    async assess(l) {
      asked.push(l.id);
      return { ok: true, item: 'PS5 Disc', condition: 'good', low: 340, high: 380, confidence: 'high', redFlags: [], verdict: 'good deal', reason: 'ok', model: 'fake' };
    },
  };
  const t = setup({ ai });
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok(history()));
  await t.monitor.scan(w);
  t.responses.push(ok([L(1, { ageMin: 1, price: 210, title: 'PS5 disc edition' }), L(2, { ageMin: 1, price: 205, title: 'PS5 disc edition' }), L(3, { ageMin: 1, price: 420, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  await drain(t.monitor);
  assert.equal(asked.length, 1, 'cap of one check');
  assert.ok(!asked.includes('3'), 'never for a clear non-deal');
  const checked = t.store.listings[asked[0]];
  assert.equal(checked.ai.model, 'fake');
  assert.ok(checked.eval.reasons.some((r) => r.text.startsWith('AI agrees')));
  const other = Object.values(t.store.listings).find((l) => ['1', '2'].includes(l.id) && l.id !== asked[0]);
  assert.equal(other.aiError, 'Daily AI check limit reached');
  assert.equal(t.sent.flatMap((s) => s.fresh).sort().join(), '1,2', 'both still alert as deals');
  t.cleanup();
});

test('price drops alert when they make it a deal (deals mode) and always in all mode', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok([...history(), L(5, { ageMin: 500, price: 390, title: 'PS5 disc edition' }), L(6, { ageMin: 500, price: 420, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  t.responses.push(ok([L(5, { ageMin: 500, price: 220, title: 'PS5 disc edition' }), L(6, { ageMin: 500, price: 400, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.at(-1), { watch: 'PS5', fresh: [], drops: ['5'] });
  assert.equal(t.store.listings['5'].prevPrice, 390);
  assert.equal(pileOf(t.store.listings['5']), 'deals');
  t.cleanup();
});

test('filters, sold items and muted watches never alert; another watch does not re-alert the same listing', async () => {
  const t = setup();
  const a = t.store.addWatch({ name: 'A', query: 'bike', exclude: ['kids'], baselineAt: Date.now(), alertMode: 'all' });
  const b = t.store.addWatch({ name: 'B', query: 'trek', baselineAt: Date.now(), alertMode: 'all' });
  t.responses.push(ok([L(20, { ageMin: 2, title: 'Kids bike' }), L(21, { ageMin: 2, sold: true }), L(22, { ageMin: 2, title: 'Trek bike' })]));
  await t.monitor.scan(a);
  assert.deepEqual(t.sent.at(-1).fresh, ['22']);
  assert.equal(pileOf(t.store.listings['20']), 'unsorted', 'filtered listings are kept, not thrown away');
  assert.equal(t.store.listings['20'].eval.headline, 'Has your skip word "kids"');
  assert.equal(t.store.listings['21'], undefined, 'sold ones are skipped');
  t.responses.push(ok([L(22, { ageMin: 3, title: 'Trek bike' })]));
  await t.monitor.scan(b);
  assert.equal(t.sent.length, 1, 'no second alert for the same listing');
  assert.deepEqual(t.store.listings['22'].watchIds, [a.id, b.id]);
  const m = t.store.addWatch({ name: 'Muted', query: 'x', mute: true, baselineAt: Date.now(), alertMode: 'all' });
  t.responses.push(ok([L(30, { ageMin: 1 })]));
  await t.monitor.scan(m);
  assert.equal(t.sent.length, 1);
  t.cleanup();
});

test('changing the deal rules re-sorts what was already found', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5' });
  t.responses.push(ok([...history(), L(1, { ageMin: 600, price: 250, title: 'PS5 disc edition' })]));
  await t.monitor.scan(w);
  assert.equal(pileOf(t.store.listings['1']), 'deals'); // +$100
  t.store.settings.deals.minProfit = 150;
  t.monitor.reevaluate();
  assert.equal(pileOf(t.store.listings['1']), 'unsorted');
  t.store.listings['1'].pileOverride = 'deals'; // your thumbs-up wins over the rules
  assert.equal(pileOf(t.store.listings['1']), 'deals');
  t.cleanup();
});

test('login walls and rate limits pause every watch, back off, and clear on success', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'Bikes', query: 'bike', intervalSec: 120 });
  t.responses.push({ ok: false, code: 'LOGIN_REQUIRED', message: 'login please', engine: 'fast', listings: [] });
  const before = Date.now();
  await t.monitor.scan(w);
  assert.equal(t.monitor.status.state, 'cooldown');
  assert.equal(t.monitor.status.problem.code, 'LOGIN_REQUIRED');
  assert.ok(w.nextScanAt >= before + 2 * 120e3, 'backs off');
  assert.equal(t.monitor.pickNext(Date.now() + 5 * MIN), null, 'paused during cooldown');
  t.monitor.queue.push(w.id); // "Check now" still goes through during a pause
  assert.equal(t.monitor.pickNext(Date.now()).manual, true);
  t.responses.push({ ok: false, code: 'RATE_LIMITED', message: 'slow down', engine: 'fast', listings: [] });
  await t.monitor.scan(w, { manual: true });
  assert.ok(t.monitor.cooldownUntil - Date.now() > 15 * MIN);
  t.responses.push(ok([L(1, { ageMin: 1 })]));
  await t.monitor.scan(w, { manual: true });
  assert.equal(t.monitor.status.state, 'running');
  assert.equal(t.monitor.status.problem, null);
  assert.equal(w.failCount, 0);
  t.cleanup();
});

test('quiet hours wrap around midnight', () => {
  const at = (h) => new Date(2026, 0, 1, h, 30);
  const q = { enabled: true, start: 23, end: 6 };
  assert.equal(inQuietHours(q, at(23)), true);
  assert.equal(inQuietHours(q, at(3)), true);
  assert.equal(inQuietHours(q, at(6)), false);
  assert.equal(inQuietHours(q, at(12)), false);
  assert.equal(inQuietHours({ ...q, enabled: false }, at(3)), false);
});

test('store survives a corrupt file and writes atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-store-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, '{"settings": {"engine": "fast"');
  const s = new Store(file);
  assert.equal(s.settings.engine, 'auto');
  assert.equal(s.settings.deals.minProfit, 40);
  assert.equal(s.settings.ai.enabled, false);
  assert.match(s.settings.notify.ntfy.topic, /^flipradar-[a-z2-9]{14}$/);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('broken')));
  s.addWatch({ name: 'x', query: 'x' });
  s.flush();
  assert.equal(new Store(file).watches.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
