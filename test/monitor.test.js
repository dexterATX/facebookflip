import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor, inQuietHours } from '../src/monitor.js';

const MIN = 60e3;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipradar-test-'));
  const store = new Store(path.join(dir, 'db.json'));
  const responses = [];
  const fb = { calls: [], async search(url) { this.calls.push(url); return responses.shift(); } };
  const sent = [];
  const notifier = { errors: {}, async sendListings(watch, fresh, drops) { sent.push({ watch: watch.name, fresh: fresh.map((l) => l.id), drops: drops.map((l) => l.id) }); } };
  const monitor = new Monitor({ store, fb, notifier, gapMs: 0 });
  return { store, fb, notifier, monitor, responses, sent, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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

test('first check is a quiet baseline, except listings posted inside the alert window', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'Bikes', query: 'bike' });
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
  const w = t.store.addWatch({ name: 'Bikes', query: 'bike' });
  t.responses.push(ok([L(1, { ageMin: 200 })]));
  await t.monitor.scan(w);
  t.responses.push(ok([L(1, { ageMin: 202 }), L(10, { ageMin: 1 }), L(11, { ageMin: 400 }), L(12)]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.at(-1).fresh.sort(), ['10', '12']);
  assert.ok(t.store.listings['11'], 'old listing is still recorded');
  assert.equal(t.store.listings['10'].alertedAt > 0, true);
  t.cleanup();
});

test('price drops on known listings are reported', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'Couch', query: 'couch' });
  t.responses.push(ok([L(5, { ageMin: 500, price: 300 })]));
  await t.monitor.scan(w);
  t.responses.push(ok([L(5, { ageMin: 500, price: 220 })]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.at(-1), { watch: 'Couch', fresh: [], drops: ['5'] });
  assert.equal(t.store.listings['5'].prevPrice, 300);
  assert.equal(t.store.listings['5'].price, 220);
  t.cleanup();
});

test('filters, sold items and muted watches never alert; another watch does not re-alert the same listing', async () => {
  const t = setup();
  const a = t.store.addWatch({ name: 'A', query: 'bike', exclude: ['kids'], baselineAt: Date.now() });
  const b = t.store.addWatch({ name: 'B', query: 'trek', baselineAt: Date.now() });
  t.responses.push(ok([L(20, { ageMin: 2, title: 'Kids bike' }), L(21, { ageMin: 2, sold: true }), L(22, { ageMin: 2, title: 'Trek bike' })]));
  await t.monitor.scan(a);
  assert.deepEqual(t.sent.at(-1).fresh, ['22']);
  assert.equal(t.store.listings['20'], undefined);
  t.responses.push(ok([L(22, { ageMin: 3, title: 'Trek bike' })]));
  await t.monitor.scan(b);
  assert.equal(t.sent.length, 1, 'no second alert for the same listing');
  assert.deepEqual(t.store.listings['22'].watchIds, [a.id, b.id]);
  const m = t.store.addWatch({ name: 'Muted', query: 'x', mute: true, baselineAt: Date.now() });
  t.responses.push(ok([L(30, { ageMin: 1 })]));
  await t.monitor.scan(m);
  assert.equal(t.sent.length, 1);
  t.cleanup();
});

test('"only deals" mode alerts on cheap listings once there is enough price history', async () => {
  const t = setup();
  const w = t.store.addWatch({ name: 'PS5', query: 'ps5', alertMode: 'deals' });
  t.responses.push(ok([300, 310, 290, 305, 295, 320, 280, 300].map((p, i) => L(100 + i, { ageMin: 600, price: p }))));
  await t.monitor.scan(w);
  t.responses.push(ok([L(200, { ageMin: 1, price: 299 }), L(201, { ageMin: 1, price: 170 })]));
  await t.monitor.scan(w);
  assert.deepEqual(t.sent.at(-1).fresh, ['201']);
  assert.equal(t.store.listings['201'].deal.label, 'steal');
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
  assert.match(s.settings.notify.ntfy.topic, /^flipradar-[a-z2-9]{14}$/);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('broken')));
  s.addWatch({ name: 'x', query: 'x' });
  s.flush();
  assert.equal(new Store(file).watches.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
